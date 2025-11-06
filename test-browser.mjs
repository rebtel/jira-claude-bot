import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright-core';
import chromiumPkg from '@sparticuz/chromium';

// === CONFIGURE THESE ===
const PREVIEW_URL = 'https://rebtel-web-git-fe-3721-implementation.reblab.net'; // Replace with actual preview URL
const JIRA_DESCRIPTION = `
On the /products page, users can edit their phone number by clicking the edit icon, which opens a modal dialog with a phone number input field. Currently, users can only close this modal using the "Cancel" button that appears inside the modal.

Description

Allow users to close the modal by clicking in the dark overlay area outside the modal, matching the same behavior as the "Cancel" button.

  Business Rules:

When a phone number exists in state:

User should be able to close the modal by clicking outside (in the dark overlay)

This matches existing Cancel button behavior (which is visible in this scenario)

When NO phone number exists in state:

Clicking outside the modal should do nothing (no feedback/animation needed)

Modal must remain open until user submits a valid phone number

This matches existing Cancel button behavior (button is hidden in this scenario)

Products cannot be displayed without a phone number, so modal closure must be blocked

  Current Behavior:

Clicking outside the modal is currently always blocked

Cancel button correctly shows/hides based on phone number existence

  Expected Behavior:

Clicking outside modal should close it only when phoneNumber exists

When no phone number exists, clicking outside does nothing (modal stays open, no feedback)



Acceptance Criteria:

When phone number exists: clicking outside modal closes it

When phone number exists: Cancel button still works

When NO phone number exists: clicking outside does NOT close modal

When NO phone number exists: no feedback/animation when clicking outside

Phone number validation requirements unchanged



repo: rebtel/rebtel-web
`.trim();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY environment variable not set');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function executeBrowserTest(previewUrl, testCode) {
  let browser;
  const steps = [];

  try {
    console.log('🌐 Launching browser...');
    const executablePath = await chromiumPkg.executablePath();
    console.log('📍 Chromium executable path:', executablePath);

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: chromiumPkg.args
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    console.log(`📍 Navigating to ${previewUrl}...`);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    const initialScreenshot = await page.screenshot({ fullPage: false });
    steps.push({
      description: 'Initial page load',
      screenshot: initialScreenshot.toString('base64')
    });

    const testHelpers = {
      page,
      async captureStep(description) {
        console.log(`📸 Capturing: ${description}`);
        const screenshot = await page.screenshot({ fullPage: false });
        steps.push({
          description,
          screenshot: screenshot.toString('base64')
        });
      }
    };

    const testFunction = new Function('helpers', testCode);
    await testFunction(testHelpers);

    console.log(`✅ Test executed successfully with ${steps.length} steps captured`);

    return { success: true, steps };
  } catch (error) {
    console.error('❌ Browser test error:', error);
    return { success: false, steps, error: error.message };
  } finally {
    if (browser) {
      await browser.close();
      console.log('🔒 Browser closed');
    }
  }
}

async function testBrowserFlow() {
  console.log('🧪 Testing browser flow locally\n');
  console.log('Preview URL:', PREVIEW_URL);
  console.log('Requirements:', JIRA_DESCRIPTION);
  console.log('\n' + '='.repeat(60) + '\n');

  try {
    // Step 1: Generate test code
    console.log('🤖 Asking Claude to generate test scenario...');
    const testPrompt = `Generate Playwright test code to verify the implementation works visually.

**Original Requirements:**
${JIRA_DESCRIPTION}

**Preview URL:** ${PREVIEW_URL}
The browser will start at the preview URL (homepage). This is a web application.

**IMPORTANT - Routing:**
- The page is already loaded at the preview URL
- DO NOT use relative paths like '/products' - the site may have locale/region routing
- Navigate using visible UI elements (buttons, links, navigation) when possible
- If you must navigate to a URL, inspect the actual site structure first by waiting for page load
- For example, if the site uses /<lang>/<region>/<page> structure, use full URLs or click navigation links

**What to test:**
- Test the specific functionality described in the requirements
- Capture screenshots at key steps to visually verify behavior
- Use reliable selectors (data-testid, aria-labels, or specific classes)

Provide ONLY the JavaScript code to execute (no markdown, no explanations). The code will be run with:
- helpers.page (Playwright Page object) - already at ${PREVIEW_URL}
- helpers.captureStep(description) (captures screenshot with description)

Example for testing a modal:
await helpers.captureStep('Page loaded');
await helpers.page.click('[data-testid="open-modal-button"]');
await helpers.page.waitForTimeout(500);
await helpers.captureStep('Modal opened');

Start your code immediately without any explanation.`;

    const testCodeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: testPrompt
      }]
    });

    const testCode = testCodeResponse.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .replace(/```javascript\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    console.log('📝 Generated test code:\n');
    console.log(testCode);
    console.log('\n' + '='.repeat(60) + '\n');

    // Step 2: Execute browser test
    console.log('🎭 Executing browser test...');
    const testResult = await executeBrowserTest(PREVIEW_URL, testCode);

    if (!testResult.success && !testResult.steps.length) {
      throw new Error(`Browser test failed: ${testResult.error}`);
    }

    console.log(`📸 Captured ${testResult.steps.length} test steps\n`);
    console.log('='.repeat(60) + '\n');

    // Step 3: Visual review
    console.log('👀 Claude reviewing test results...');

    const imageBlocks = testResult.steps.map(step => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: step.screenshot
      }
    }));

    const reviewPrompt = `Review these browser test screenshots and determine if the implementation works correctly.

**Original Requirements:**
${JIRA_DESCRIPTION}

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
      .map(block => block.text)
      .join('\n');

    console.log('\n📋 Visual Review Result:\n');
    console.log(reviewText);
    console.log('\n' + '='.repeat(60) + '\n');

    if (reviewText.includes('NEEDS_REVISION')) {
      console.log('❌ Test failed - revision would be needed');
    } else {
      console.log('✅ Test passed!');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

testBrowserFlow();
