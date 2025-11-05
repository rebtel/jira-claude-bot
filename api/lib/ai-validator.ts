/**
 * AI Ticket Validator
 * Uses Claude to validate that Jira tickets have sufficient information
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ValidationResult } from './types.js';

// Validate ticket content with Claude before processing
export async function validateTicketContent(
  issueKey: string,
  summary: string,
  description: string
): Promise<ValidationResult> {
  try {
    console.log(`Validating ticket ${issueKey}...`);

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const validationPrompt = `
Review this Jira ticket and determine if there's enough information to make a quality code change.

**Ticket:** ${issueKey}
**Summary:** ${summary}
**Description:** ${description}

Evaluate these criteria (be lenient - this is written by a PM, not a developer):
1. Is there a clear description of WHAT needs to change from a user perspective?
2. Is there at least some indication of the desired behavior or outcome?
3. Is the repository specified in the format "repo: owner/repo-name"?

You do NOT need:
- Specific file paths or component names
- Technical implementation details
- State management patterns
- Exact acceptance criteria

If the ticket describes the user-facing change clearly enough that a developer could figure out what to implement, it's valid.

Respond in JSON format only (no other text):
{
  "valid": true or false,
  "reasoning": "brief explanation of your decision",
  "missing_information": ["item1", "item2"] // only if valid=false, list what's missing
}
`.trim();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: validationPrompt
      }]
    });

    // Extract text from response
    const textContent = response.content.find(block => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not find JSON in Claude response');
    }

    const result: ValidationResult = JSON.parse(jsonMatch[0]);
    console.log('Validation result:', result);

    return result;
  } catch (error) {
    console.error('Error validating ticket:', error);
    // On validation error, allow processing to continue but log the issue
    return {
      valid: true,
      reasoning: 'Validation check failed, proceeding with caution'
    };
  }
}
