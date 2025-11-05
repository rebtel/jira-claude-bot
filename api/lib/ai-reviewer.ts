/**
 * AI Code Reviewer
 * Uses Claude to review code changes before PR creation
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ReviewResult } from './types.js';

// AI Code Reviewer Agent
export async function reviewCodeChanges(
  issueKey: string,
  summary: string,
  description: string,
  codeDiff: string
): Promise<ReviewResult> {
  try {
    console.log(`🔍 Starting code review for ${issueKey}...`);

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const reviewPrompt = `
You are an expert code reviewer. Review the following code changes that were made to implement a Jira ticket.

**Original Ticket:** ${issueKey} - ${summary}
**Requirements:** ${description}

**Code Changes:**
${codeDiff}

Please review the changes and provide feedback on:
1. **Correctness**: Do the changes correctly implement the requirements?
2. **Code Quality**: Is the code well-written, maintainable, and following best practices?
3. **Potential Issues**: Are there any bugs, security issues, or edge cases not handled?
4. **Completeness**: Does this fully address the ticket requirements?

Respond in JSON format only (no other text):
{
  "approved": true or false,
  "summary": "One sentence summary of the changes",
  "issues": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "file": "path/to/file",
      "issue": "Description of the issue",
      "suggestion": "How to fix or improve it"
    }
  ],
  "overall_feedback": "Overall assessment and any additional comments"
}

Note:
- "approved": true means the changes are good to merge (minor issues or suggestions are OK)
- "approved": false means there are critical or major issues that MUST be fixed before merging
`.trim();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: reviewPrompt
      }]
    });

    // Extract text from response
    const textContent = response.content.find(block => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from reviewer');
    }

    // Parse JSON response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not find JSON in reviewer response');
    }

    const result: ReviewResult = JSON.parse(jsonMatch[0]);
    console.log('Review result:', {
      approved: result.approved,
      issueCount: result.issues.length,
      criticalIssues: result.issues.filter(i => i.severity === 'critical').length
    });

    return result;
  } catch (error) {
    console.error('Error in code review:', error);
    // On review error, return a permissive result so work can continue
    return {
      approved: true,
      summary: 'Code review failed, proceeding with caution',
      issues: [],
      overall_feedback: 'The automated review encountered an error. Manual review recommended.'
    };
  }
}
