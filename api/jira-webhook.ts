import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Import all extracted modules
import { addJiraComment, transitionJiraTicket } from './lib/jira-client.js';
import { getCodeDiff } from './lib/github-client.js';
import { validateTicketContent } from './lib/ai-validator.js';
import { reviewCodeChanges } from './lib/ai-reviewer.js';
import { getAgentTools, getInitialPrompt } from './lib/agent-tools.js';
import { waitForVercelDeployment } from './lib/vercel-client.js';
import { executeBrowserTest, getTestCodeTemplate } from './lib/browser-tester.js';
import type { ReviewResult } from './lib/types.js';

/**
 * Main Webhook Handler
 * Receives Jira webhooks and orchestrates the entire process
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('=== Webhook received ===');
    console.log('Method:', req.method);
    console.log('Content-Type:', req.headers['content-type']);

    // Verify webhook (optional but recommended)
    // TEMPORARILY DISABLED FOR TESTING
    // const webhookSecret = process.env.JIRA_WEBHOOK_SECRET;
    // if (webhookSecret && req.headers['x-webhook-secret'] !== webhookSecret) {
    //   return res.status(401).json({ error: 'Unauthorized' });
    // }

    // Parse Jira webhook payload (automation format)
    const { issue } = req.body;

    if (!issue) {
      console.log('⚠️ No issue found in webhook payload');
      return res.status(200).json({
        message: 'Ignored - no issue data'
      });
    }

    console.log('Issue key:', issue.key);
    console.log('Issue labels:', JSON.stringify(issue.fields?.labels));

    // Check if the issue has the 'claude-code' label
    const hasClaudeCodeLabel = issue.fields?.labels?.some((label: any) =>
      label === 'claude-code' || label.name === 'claude-code'
    );

    if (!hasClaudeCodeLabel) {
      console.log('⚠️ Issue does not have claude-code label');
      return res.status(200).json({
        message: 'Ignored - claude-code label not present'
      });
    }

    console.log('✓ Issue has claude-code label, proceeding...');

    const issueKey = issue.key;
    const summary = issue.fields.summary;
    const description = issue.fields.description || '';

    // Validate ticket content before processing
    console.log('🔍 Validating ticket content...');
    const validationResult = await validateTicketContent(issueKey, summary, description);

    if (!validationResult.valid) {
      console.log('❌ Ticket validation failed:', validationResult.reasoning);

      // Build feedback message
      let feedbackMessage = `⚠️ **Ticket Validation Failed**\n\n${validationResult.reasoning}`;

      if (validationResult.missing_information && validationResult.missing_information.length > 0) {
        feedbackMessage += '\n\n**Missing Information:**\n';
        validationResult.missing_information.forEach(item => {
          feedbackMessage += `• ${item}\n`;
        });
      }

      feedbackMessage += '\n\nPlease update the ticket with the required information and trigger the webhook again.';

      // Post feedback to Jira
      await addJiraComment(issueKey, feedbackMessage);

      return res.status(200).json({
        message: 'Ticket validation failed',
        issueKey,
        reasoning: validationResult.reasoning
      });
    }

    console.log('✅ Ticket validation passed:', validationResult.reasoning);

    // Extract repository from custom field or description
    // Assuming repo is in format: repo: owner/repo-name
    const repoMatch = description.match(/repo:\s*([^\s]+)/i);
    const repository = repoMatch ? repoMatch[1] : process.env.DEFAULT_REPO;

    if (!repository) {
      throw new Error('No repository specified in issue');
    }

    console.log(`Processing ${issueKey}: ${summary}`);
    console.log(`Target repository: ${repository}`);

    // Process the issue (await to keep function alive)
    await processIssueAsync(issueKey, summary, description, repository);

    // Return after processing
    return res.status(200).json({
      message: 'Processing completed',
      issueKey
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function processIssueAsync(
  issueKey: string,
  summary: string,
  description: string,
  repository: string
) {
  try {
    // Check for required API keys
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ ANTHROPIC_API_KEY is not set!');
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    if (!process.env.GITHUB_TOKEN) {
      console.error('❌ GITHUB_TOKEN is not set!');
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

    console.log('✓ Environment variables check passed');

    // Initialize clients
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });

    const [owner, repo] = repository.split('/');
    const branchName = `${issueKey.toLowerCase()}-implementation`;

    console.log(`Working on: ${owner}/${repo}, branch: ${branchName}`);

    // Get tool definitions and initial prompt
    const tools = getAgentTools();
    const userPrompt = getInitialPrompt(issueKey, summary, description, owner, repo, branchName);

    console.log('Starting Claude conversation with tools...');

    const messages: Anthropic.MessageParam[] = [{
      role: 'user',
      content: userPrompt
    }];

    let defaultBranch = '';
    let branchSha = '';
    const filesRead = new Set<string>(); // Track which files have been read
    let reviewCompleted = false; // Track if code review has been done
    let lastReviewResult: ReviewResult | null = null; // Store last review result
    let createdPrNumber: number | null = null; // Track created PR for browser testing

    // Agentic loop (increased limit to allow for codebase exploration)
    for (let i = 0; i < 25; i++) {
      console.log(`\n--- Turn ${i + 1} ---`);

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192, // Increased for more complex tasks
        tools,
        messages
      });

      console.log(`Stop reason: ${response.stop_reason}`);

      // Add assistant response to messages
      messages.push({
        role: 'assistant',
        content: response.content
      });

      // Check if we're done
      if (response.stop_reason === 'end_turn') {
        console.log('✓ Task completed!');
        for (const block of response.content) {
          if (block.type === 'text') {
            console.log(block.text);
          }
        }
        break;
      }

      // Check if there are any tool_use blocks (regardless of stop_reason)
      const hasToolUses = response.content.some(block => block.type === 'tool_use');

      // Process tool uses
      if (hasToolUses) {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        // Log all blocks for debugging
        console.log('Content blocks:', response.content.map(b => ({ type: b.type, id: (b as any).id })));

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            console.log(`Tool: ${block.name}`, block.input);

            try {
              let result: any = null;

              if (block.name === 'read_file') {
                const input = block.input as { path: string };
                try {
                  const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: input.path,
                    ref: defaultBranch || undefined
                  });

                  if ('content' in data && typeof data.content === 'string') {
                    const content = Buffer.from(data.content, 'base64').toString('utf-8');
                    filesRead.add(input.path); // Track that this file was read
                    result = { success: true, path: input.path, content };
                  } else {
                    result = { error: 'Path is a directory, not a file' };
                  }
                } catch (error: any) {
                  if (error.status === 404) {
                    result = { error: `File not found: ${input.path}` };
                  } else {
                    throw error;
                  }
                }
              }

              else if (block.name === 'list_files') {
                const input = block.input as { path: string };
                try {
                  const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: input.path || '',
                    ref: defaultBranch || undefined
                  });

                  if (Array.isArray(data)) {
                    const files = data.map(item => ({
                      name: item.name,
                      path: item.path,
                      type: item.type
                    }));
                    result = { success: true, path: input.path, files };
                  } else {
                    result = { error: 'Path is a file, not a directory' };
                  }
                } catch (error: any) {
                  if (error.status === 404) {
                    result = { error: `Directory not found: ${input.path}` };
                  } else {
                    throw error;
                  }
                }
              }

              else if (block.name === 'search_code') {
                const input = block.input as { query: string };
                try {
                  const { data } = await octokit.search.code({
                    q: `${input.query}+repo:${owner}/${repo}`
                  });

                  const results = data.items.slice(0, 10).map(item => ({
                    path: item.path,
                    name: item.name
                  }));

                  result = {
                    success: true,
                    query: input.query,
                    total_count: data.total_count,
                    results
                  };
                } catch (error: any) {
                  result = { error: `Search failed: ${error.message}` };
                }
              }

              else if (block.name === 'get_default_branch') {
                const { data } = await octokit.repos.get({ owner, repo });
                defaultBranch = data.default_branch;
                const branchData = await octokit.repos.getBranch({ owner, repo, branch: defaultBranch });
                branchSha = branchData.data.commit.sha;
                result = { default_branch: defaultBranch, sha: branchSha };
              }

              else if (block.name === 'create_branch') {
                try {
                  await octokit.git.createRef({
                    owner,
                    repo,
                    ref: `refs/heads/${branchName}`,
                    sha: branchSha
                  });
                  result = { success: true, branch: branchName };
                } catch (branchError: any) {
                  if (branchError.status === 422) {
                    // Branch already exists, that's okay
                    console.log(`ℹ️ Branch ${branchName} already exists, continuing...`);
                    result = { success: true, branch: branchName, already_exists: true };
                  } else {
                    throw branchError;
                  }
                }
              }

              else if (block.name === 'update_file') {
                const input = block.input as { path: string; content: string; message: string };

                // Enforce that file was read first
                if (!filesRead.has(input.path)) {
                  result = {
                    error: `You must read the file "${input.path}" with read_file before updating it. This ensures you understand the existing code before making changes.`
                  };
                } else {
                  // Get the file SHA from the source branch (not the new branch which might be empty)
                  try {
                    // First try to get SHA from the new branch (in case file was already modified there)
                    let fileSha: string;
                    try {
                      const { data: branchFileData } = await octokit.repos.getContent({
                        owner,
                        repo,
                        path: input.path,
                        ref: branchName
                      });
                      if ('sha' in branchFileData) {
                        fileSha = branchFileData.sha;
                      } else {
                        throw new Error('Path is a directory, not a file');
                      }
                    } catch (branchError: any) {
                      if (branchError.status === 404) {
                        // File doesn't exist in new branch yet, get SHA from default branch
                        const { data: defaultFileData } = await octokit.repos.getContent({
                          owner,
                          repo,
                          path: input.path,
                          ref: defaultBranch
                        });
                        if ('sha' in defaultFileData) {
                          fileSha = defaultFileData.sha;
                        } else {
                          throw new Error('Path is a directory, not a file');
                        }
                      } else {
                        throw branchError;
                      }
                    }

                    await octokit.repos.createOrUpdateFileContents({
                      owner,
                      repo,
                      path: input.path,
                      message: input.message,
                      content: Buffer.from(input.content).toString('base64'),
                      branch: branchName,
                      sha: fileSha
                    });
                    result = { success: true, path: input.path, action: 'updated' };
                  } catch (error: any) {
                    if (error.status === 404) {
                      result = { error: `File "${input.path}" does not exist in the repository. Use create_file to create new files, not update_file.` };
                    } else {
                      throw error;
                    }
                  }
                }
              }

              else if (block.name === 'create_file') {
                const input = block.input as { path: string; content: string; message: string };

                // Check if file already exists
                try {
                  await octokit.repos.getContent({
                    owner,
                    repo,
                    path: input.path,
                    ref: branchName
                  });
                  result = {
                    error: `File "${input.path}" already exists! Use update_file to modify existing files, not create_file.`
                  };
                } catch (error: any) {
                  if (error.status === 404) {
                    // File doesn't exist, we can create it
                    await octokit.repos.createOrUpdateFileContents({
                      owner,
                      repo,
                      path: input.path,
                      message: input.message,
                      content: Buffer.from(input.content).toString('base64'),
                      branch: branchName
                    });
                    result = { success: true, path: input.path, action: 'created' };
                  } else {
                    throw error;
                  }
                }
              }

              else if (block.name === 'request_code_review') {
                // Check if there are any changes to review
                if (!defaultBranch || !branchName) {
                  result = { error: 'No branch created yet. Please create a branch and make changes first.' };
                } else {
                  try {
                    // Get the diff between branches
                    console.log(`📊 Fetching diff between ${defaultBranch} and ${branchName}...`);
                    const codeDiff = await getCodeDiff(octokit, owner, repo, defaultBranch, branchName);

                    if (codeDiff.includes('No changes detected')) {
                      result = {
                        error: 'No changes detected. Please make code changes before requesting a review.'
                      };
                    } else {
                      // Run the AI reviewer
                      const reviewResult = await reviewCodeChanges(issueKey, summary, description, codeDiff);
                      lastReviewResult = reviewResult;
                      reviewCompleted = true;

                      // Format the review feedback for Claude
                      let feedback = `# Code Review Results\n\n`;
                      feedback += `**Status:** ${reviewResult.approved ? '✅ APPROVED' : '❌ CHANGES REQUESTED'}\n`;
                      feedback += `**Summary:** ${reviewResult.summary}\n\n`;

                      if (reviewResult.issues.length > 0) {
                        feedback += `## Issues Found (${reviewResult.issues.length})\n\n`;

                        // Group by severity
                        const critical = reviewResult.issues.filter(i => i.severity === 'critical');
                        const major = reviewResult.issues.filter(i => i.severity === 'major');
                        const minor = reviewResult.issues.filter(i => i.severity === 'minor');
                        const suggestions = reviewResult.issues.filter(i => i.severity === 'suggestion');

                        if (critical.length > 0) {
                          feedback += `### 🔴 Critical Issues (${critical.length})\n`;
                          critical.forEach((issue, idx) => {
                            feedback += `${idx + 1}. **${issue.file}**\n`;
                            feedback += `   - Issue: ${issue.issue}\n`;
                            feedback += `   - Suggestion: ${issue.suggestion}\n\n`;
                          });
                        }

                        if (major.length > 0) {
                          feedback += `### 🟡 Major Issues (${major.length})\n`;
                          major.forEach((issue, idx) => {
                            feedback += `${idx + 1}. **${issue.file}**\n`;
                            feedback += `   - Issue: ${issue.issue}\n`;
                            feedback += `   - Suggestion: ${issue.suggestion}\n\n`;
                          });
                        }

                        if (minor.length > 0) {
                          feedback += `### 🔵 Minor Issues (${minor.length})\n`;
                          minor.forEach((issue, idx) => {
                            feedback += `${idx + 1}. **${issue.file}**\n`;
                            feedback += `   - Issue: ${issue.issue}\n`;
                            feedback += `   - Suggestion: ${issue.suggestion}\n\n`;
                          });
                        }

                        if (suggestions.length > 0) {
                          feedback += `### 💡 Suggestions (${suggestions.length})\n`;
                          suggestions.forEach((issue, idx) => {
                            feedback += `${idx + 1}. **${issue.file}**\n`;
                            feedback += `   - ${issue.issue}\n`;
                            feedback += `   - ${issue.suggestion}\n\n`;
                          });
                        }
                      } else {
                        feedback += `✅ No issues found!\n\n`;
                      }

                      feedback += `## Overall Feedback\n${reviewResult.overall_feedback}\n\n`;

                      if (!reviewResult.approved) {
                        feedback += `---\n**Action Required:** Please address the critical and major issues above before creating the pull request. You can make revisions using update_file, then call request_code_review again to verify your fixes.\n`;
                      } else {
                        feedback += `---\n**Next Step:** The code looks good! You can now proceed to create the pull request.\n`;
                      }

                      result = {
                        success: true,
                        approved: reviewResult.approved,
                        feedback: feedback
                      };

                      console.log(`✓ Review completed: ${reviewResult.approved ? 'APPROVED' : 'CHANGES REQUESTED'}`);
                    }
                  } catch (error: any) {
                    result = { error: `Review failed: ${error.message}` };
                  }
                }
              }

              else if (block.name === 'create_pull_request') {
                // Enforce code review before PR creation
                if (!reviewCompleted) {
                  result = {
                    error: 'Code review required! You must call request_code_review before creating a pull request. This ensures code quality.'
                  };
                } else if (lastReviewResult && !lastReviewResult.approved) {
                  result = {
                    error: `Code review found issues that must be addressed first. Please fix the critical/major issues identified in the review, then call request_code_review again to verify your fixes.`
                  };
                } else {
                  // Review passed, create the PR
                  const input = block.input as { title: string; body: string };

                  // Enhance PR body with review summary
                  let enhancedBody = input.body;
                  if (lastReviewResult) {
                    enhancedBody += `\n\n---\n## AI Code Review Summary\n\n`;
                    enhancedBody += `✅ **Approved by AI Reviewer**\n\n`;
                    enhancedBody += `${lastReviewResult.summary}\n\n`;
                    if (lastReviewResult.issues.length > 0) {
                      enhancedBody += `*Review identified ${lastReviewResult.issues.length} minor suggestion(s) that were addressed or deemed acceptable.*\n`;
                    }
                  }

                  const { data: pr } = await octokit.pulls.create({
                    owner,
                    repo,
                    title: input.title,
                    body: enhancedBody,
                    head: branchName,
                    base: defaultBranch
                  });
                  createdPrNumber = pr.number; // Store for browser testing
                  result = { success: true, pr_url: pr.html_url, pr_number: pr.number };
                  console.log(`✓ PR created: ${pr.html_url}`);

                  // Post success comment to Jira with PR link
                  try {
                    await addJiraComment(
                      issueKey,
                      `✅ **Pull Request Created**\n\nYour code changes have been implemented and a pull request has been created:\n\n🔗 [${input.title}](${pr.html_url})\n\n**Branch:** ${branchName}\n**PR #${pr.number}**`
                    );
                  } catch (commentError) {
                    console.error('Failed to post PR comment to Jira:', commentError);
                    // Don't fail the whole process if comment fails
                  }

                  // Transition ticket to Code Review status
                  try {
                    await transitionJiraTicket(issueKey, '11. Code Review');
                  } catch (transitionError) {
                    console.error('Failed to transition ticket status:', transitionError);
                    // Don't fail the whole process if status transition fails
                  }
                }
              }

              else {
                // Unknown tool
                result = { error: `Unknown tool: ${block.name}` };
                console.warn(`⚠️ Unknown tool requested: ${block.name}`);
              }

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result)
              });

            } catch (error: any) {
              console.error(`Error with ${block.name}:`, error.message);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: error.message }),
                is_error: true
              });
            }
          }
        }

        // Add tool results to messages
        console.log('Tool results being added:', toolResults.map(r => ({ id: r.tool_use_id, hasError: r.is_error })));

        messages.push({
          role: 'user',
          content: toolResults
        });
      }
    }

    // === BROWSER TESTING PHASE ===
    // Only run if a PR was created
    if (createdPrNumber) {
      console.log('\n=== 🌐 Starting Browser Testing Phase ===');

      try {
        // Wait for Vercel deployment
        const previewUrl = await waitForVercelDeployment(octokit, owner, repo, createdPrNumber, 5);

        if (!previewUrl) {
          console.log('⚠️ Could not get Vercel preview URL, skipping browser tests');
          await addJiraComment(
            issueKey,
            `⚠️ **Browser Testing Skipped**\n\nCould not detect Vercel preview deployment within timeout. Manual testing recommended.`
          );
        } else {
          console.log(`✅ Preview URL ready: ${previewUrl}`);

          // Post update to Jira
          await addJiraComment(
            issueKey,
            `🔍 **Starting Browser Tests**\n\nVercel preview deployed at: ${previewUrl}\n\nRunning automated visual verification...`
          );

          // Ask Claude to generate test code with codebase context
          console.log('🤖 Asking Claude to generate test scenario...');
          const testPrompt = `You have access to the full codebase via GitHub. Generate Playwright test code to verify the implementation works visually.

**IMPORTANT - Use Codebase Context:**
Before writing the test code, you should:
1. Search the codebase for relevant components (e.g., if requirements mention "edit button", search for the component)
2. Read the component files to find actual selectors (data-testid, aria-labels, classes, etc.)
3. Use the REAL selectors from the code, not generic guesses

The code is in the GitHub repository: ${owner}/${repo} on branch ${branchName}

**Requirements:**
${description}

**Your Task:**
1. First, search/read the codebase to understand the component structure and find selectors
2. Then, provide ONLY the Playwright test JavaScript code (no markdown, no explanations)

**Preview URL (Base):** ${previewUrl}
The browser will start at this URL (homepage).

**CRITICAL - Path Handling:**
- The page is already loaded at ${previewUrl} (may auto-redirect to include locale like /en/)
- If requirements mention a path like "/en/recharge/mexico/products", you MUST construct the URL correctly
- Get the page's origin (domain only): const origin = new URL(helpers.page.url()).origin;
- Then navigate: await helpers.page.goto(origin + '/en/recharge/mexico/products');
- This prevents doubling locale paths (e.g., /en/en/recharge...)

**Navigation Strategy:**
1. For specific paths in requirements:
   - const origin = new URL(helpers.page.url()).origin;
   - await helpers.page.goto(origin + '/the/path/from/requirements');
   - await helpers.page.waitForLoadState('networkidle');
2. For UI navigation, click links/buttons on the page
3. NEVER use relative paths or hardcode the preview URL structure

**What to test:**
- Test the specific functionality described in the requirements
- USE the selectors found in the Component Inspection Results above
- Capture screenshots at key steps to visually verify behavior
- Wait for elements to be ready before interacting (use waitForSelector)

Provide ONLY the JavaScript code to execute (no markdown, no explanations). The code will be run with:
- helpers.page (Playwright Page object) - already at ${previewUrl}
- helpers.captureStep(description) (captures screenshot with description)

Example structure (adapt based on inspection results):
const origin = new URL(helpers.page.url()).origin;
await helpers.page.goto(origin + '/en/recharge/mexico/products?msisdn=+123456');
await helpers.page.waitForLoadState('networkidle');
await helpers.captureStep('Products page loaded');
await helpers.page.waitForSelector('THE_SELECTOR_FROM_INSPECTION');
await helpers.page.click('THE_SELECTOR_FROM_INSPECTION');
await helpers.page.waitForTimeout(500);
await helpers.captureStep('Modal opened');

Start your code immediately without any explanation.`;

          // Create a mini agentic loop for test code generation with file access
          const testGenMessages: Anthropic.MessageParam[] = [{
            role: 'user',
            content: testPrompt
          }];

          const searchAndReadTools = tools.filter(t =>
            t.name === 'search_files' || t.name === 'read_file' || t.name === 'list_files'
          );

          let testCode = '';

          // Mini agentic loop (max 5 turns for searching/reading)
          for (let turn = 0; turn < 5; turn++) {
            const testCodeResponse = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 4000,
              tools: searchAndReadTools,
              messages: testGenMessages
            });

            testGenMessages.push({
              role: 'assistant',
              content: testCodeResponse.content
            });

            // Extract text content
            const textContent = testCodeResponse.content
              .filter(block => block.type === 'text')
              .map(block => (block as any).text)
              .join('\n');

            console.log(`  Turn ${turn + 1} text content (first 300 chars):`, textContent.substring(0, 300));

            // Try to extract code - look for code blocks or direct code
            if (textContent) {
              // Remove markdown code blocks
              let extractedCode = textContent
                .replace(/```javascript\n?/g, '')
                .replace(/```js\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();

              // If we see Playwright code, save it
              if (extractedCode.includes('helpers.page') || extractedCode.includes('helpers.captureStep')) {
                testCode = extractedCode;
                console.log('  ✓ Found test code with helpers');
              } else if (extractedCode.includes('await ') && extractedCode.includes('.goto')) {
                // Sometimes it might not use helpers variable name
                testCode = extractedCode;
                console.log('  ✓ Found test code with goto');
              }
            }

            // Check if done
            if (testCodeResponse.stop_reason === 'end_turn') {
              console.log(`  Stop reason: end_turn at turn ${turn + 1}`);
              break;
            }

            // Process tool uses
            const hasToolUses = testCodeResponse.content.some(block => block.type === 'tool_use');
            if (!hasToolUses) break;

            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const block of testCodeResponse.content) {
              if (block.type === 'tool_use') {
                console.log(`  Test gen tool: ${block.name}`);

                let result: any = null;

                if (block.name === 'search_files') {
                  const input = block.input as { query: string; file_extension?: string };
                  try {
                    const searchQuery = `${input.query}${input.file_extension ? ` extension:${input.file_extension}` : ''} repo:${owner}/${repo}`;
                    const { data } = await octokit.search.code({
                      q: searchQuery
                    });
                    result = {
                      success: true,
                      files: data.items.slice(0, 10).map(item => ({
                        path: item.path,
                        score: item.score
                      }))
                    };
                  } catch (error: any) {
                    result = { error: error.message };
                  }
                } else if (block.name === 'read_file') {
                  const input = block.input as { path: string };
                  try {
                    const { data } = await octokit.repos.getContent({
                      owner,
                      repo,
                      path: input.path,
                      ref: branchName
                    });
                    if ('content' in data && typeof data.content === 'string') {
                      const content = Buffer.from(data.content, 'base64').toString('utf-8');
                      result = { success: true, path: input.path, content };
                    } else {
                      result = { error: 'Path is a directory' };
                    }
                  } catch (error: any) {
                    result = { error: error.message };
                  }
                } else if (block.name === 'list_files') {
                  const input = block.input as { path: string };
                  try {
                    const { data } = await octokit.repos.getContent({
                      owner,
                      repo,
                      path: input.path || '',
                      ref: branchName
                    });
                    if (Array.isArray(data)) {
                      result = {
                        success: true,
                        files: data.map(item => ({
                          name: item.name,
                          type: item.type,
                          path: item.path
                        }))
                      };
                    } else {
                      result = { error: 'Path is not a directory' };
                    }
                  } catch (error: any) {
                    result = { error: error.message };
                  }
                }

                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: JSON.stringify(result)
                });
              }
            }

            if (toolResults.length > 0) {
              testGenMessages.push({
                role: 'user',
                content: toolResults
              });
            }
          }

          if (!testCode) {
            console.error('❌ Failed to generate test code');
            console.error('Final messages:', JSON.stringify(testGenMessages, null, 2).substring(0, 1000));

            await addJiraComment(
              issueKey,
              `❌ **Browser Test Generation Failed**\n\nCould not generate test code after searching the codebase. This might mean:\n- The components mentioned in the requirements don't exist yet\n- The selectors couldn't be determined from the code\n\nSkipping browser tests for now.`
            );

            // Don't throw, just skip browser testing
            console.log('Skipping browser tests due to code generation failure');
            // Continue to post comment and complete
            const prUrl = `https://github.com/${owner}/${repo}/pull/${createdPrNumber}`;
            await addJiraComment(
              issueKey,
              `✅ **Implementation Complete** (Browser tests skipped)\n\nPull Request: ${prUrl}`
            );
            return;
          }

          console.log('📝 Generated test code:', testCode.substring(0, 200) + '...');

          // Execute browser test
          console.log('🎭 Executing browser test...');
          const testResult = await executeBrowserTest(previewUrl, testCode);

          if (!testResult.success && !testResult.steps.length) {
            throw new Error(`Browser test failed: ${testResult.error}`);
          }

          console.log(`📸 Captured ${testResult.steps.length} test steps`);

          // Have Claude review the screenshots
          console.log('👀 Claude reviewing test results...');

          const imageBlocks = testResult.steps.map(step => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: 'image/png' as const,
              data: step.screenshot
            }
          }));

          const reviewPrompt = `Review these browser test screenshots and determine if the implementation works correctly.

**Original Requirements:**
${description}

**Test Steps Captured:**
${testResult.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}

**Your Task:**
Analyze the screenshots and determine if the feature works as intended. Look for:
1. Does the visual behavior match the requirements?
2. Are there any errors or broken UI elements?
3. Does the feature actually work (e.g., modal closes, button does something, etc.)?

**Response Format:**
If everything works: Start with "APPROVED:" followed by explanation
If there are issues: Start with "NEEDS_REVISION:" followed by detailed explanation of what's wrong and how to fix it`;

          const visualReview = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: reviewPrompt },
                ...imageBlocks
              ]
            }]
          });

          const reviewText = visualReview.content
            .filter(block => block.type === 'text')
            .map(block => (block as any).text)
            .join('\n');

          console.log('📋 Visual review result:', reviewText.substring(0, 200) + '...');

          // Check if revision is needed
          if (reviewText.includes('NEEDS_REVISION')) {
            console.log('🔄 Visual verification failed - requesting code revision...');

            // Post review to Jira
            await addJiraComment(
              issueKey,
              `❌ **Browser Test Failed**\n\n${reviewText}\n\n🔄 Requesting automated revision...`
            );

            // Ask Claude to revise the code
            const revisionPrompt = `The browser tests show the implementation doesn't work correctly.

**Review Feedback:**
${reviewText}

**Task:** Fix the code to address the visual issues. Provide the file paths and complete updated code for any files that need changes.

Format:
FILE: path/to/file.ext
\`\`\`
[complete updated code]
\`\`\``;

            const revisionResponse = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 8000,
              messages: [{
                role: 'user',
                content: revisionPrompt
              }]
            });

            const revisionText = revisionResponse.content
              .filter(block => block.type === 'text')
              .map(block => (block as any).text)
              .join('\n');

            // Parse revision changes
            const filePattern = /FILE:\s*(.+?)\n```[\w]*\n([\s\S]+?)\n```/g;
            let match;
            const revisions: Array<{ path: string; content: string }> = [];

            while ((match = filePattern.exec(revisionText)) !== null) {
              revisions.push({
                path: match[1].trim(),
                content: match[2]
              });
            }

            if (revisions.length > 0) {
              console.log(`✏️ Applying ${revisions.length} file revision(s)...`);

              // Apply revisions to the PR branch
              for (const revision of revisions) {
                try {
                  // Get file SHA
                  const { data: fileData } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: revision.path,
                    ref: branchName
                  });

                  if ('sha' in fileData) {
                    await octokit.repos.createOrUpdateFileContents({
                      owner,
                      repo,
                      path: revision.path,
                      message: `AI revision based on browser test feedback\n\n${reviewText.substring(0, 200)}`,
                      content: Buffer.from(revision.content).toString('base64'),
                      branch: branchName,
                      sha: fileData.sha
                    });
                    console.log(`✅ Updated ${revision.path}`);
                  }
                } catch (error) {
                  console.error(`Failed to update ${revision.path}:`, error);
                }
              }

              // Post revision update to Jira
              await addJiraComment(
                issueKey,
                `🔄 **Revision Applied**\n\nUpdated ${revisions.length} file(s) based on browser test feedback. New deployment will be created automatically.`
              );

              console.log('✅ Revisions applied successfully');
            } else {
              console.log('⚠️ Could not parse revision code from Claude response');
            }

          } else {
            console.log('✅ Browser tests passed!');

            // Post success to Jira
            await addJiraComment(
              issueKey,
              `✅ **Browser Tests Passed**\n\n${reviewText}\n\nThe implementation has been visually verified and works as expected!`
            );
          }
        }

      } catch (browserTestError) {
        console.error('Browser testing error:', browserTestError);
        await addJiraComment(
          issueKey,
          `⚠️ **Browser Testing Error**\n\nAn error occurred during automated browser testing:\n\n${browserTestError instanceof Error ? browserTestError.message : String(browserTestError)}\n\nManual verification recommended.`
        );
      }
    }

  } catch (error) {
    console.error(`❌ Error processing ${issueKey}:`, error);
    console.error('Error details:', JSON.stringify(error, null, 2));
  }
}
