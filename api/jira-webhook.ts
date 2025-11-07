import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Import all extracted modules
import { addJiraComment, transitionJiraTicket } from './lib/jira-client.js';
import { getCodeDiff } from './lib/github-client.js';
import { validateTicketContent } from './lib/ai-validator.js';
import { reviewCodeChanges } from './lib/ai-reviewer.js';
import { getAgentTools, getInitialPrompt } from './lib/agent-tools.js';
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
    let createdPrNumber: number | null = null; // Track created PR

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
                  createdPrNumber = pr.number;
                  result = {
                    success: true,
                    pr_url: pr.html_url,
                    pr_number: pr.number
                  };
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

    // === COMPLETION ===
    if (createdPrNumber) {
      console.log('\n=== ✅ Implementation Complete ===');
      console.log(`   PR Number: ${createdPrNumber}`);

      try {
        const prUrl = `https://github.com/${owner}/${repo}/pull/${createdPrNumber}`;

        await addJiraComment(
          issueKey,
          `✅ **Implementation Complete**\n\n` +
          `Pull Request: [#${createdPrNumber}](${prUrl})\n\n` +
          `**Next Steps:**\n` +
          `- Review the code changes in the PR\n` +
          `- Test the changes in a preview deployment\n` +
          `- Merge when ready!`
        );

        console.log(`✅ Successfully completed ${issueKey}`);

      } catch (error) {
        console.error('Error in completion phase:', error);
      }
    }

  } catch (error) {
    console.error(`❌ Error processing ${issueKey}:`, error);
    console.error('Error details:', JSON.stringify(error, null, 2));
  }
}
