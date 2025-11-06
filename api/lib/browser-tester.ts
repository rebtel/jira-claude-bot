import { chromium } from 'playwright-core';
import chromiumPkg from '@sparticuz/chromium';

export interface TestStep {
  description: string;
  screenshot: string; // base64
}

export interface BrowserTestResult {
  success: boolean;
  steps: TestStep[];
  error?: string;
}

/**
 * Execute browser test scenario with visual verification
 */
export async function executeBrowserTest(
  previewUrl: string,
  testCode: string
): Promise<BrowserTestResult> {
  let browser;
  const steps: TestStep[] = [];

  try {
    console.log('🌐 Launching browser...');

    // Get chromium executable path for serverless environment
    const executablePath = await chromiumPkg.executablePath();
    console.log('📍 Chromium executable path:', executablePath);

    // Launch headless Chromium with serverless-optimized settings
    browser = await chromium.launch({
      executablePath,
      headless: chromiumPkg.headless,
      args: chromiumPkg.args,
      defaultViewport: chromiumPkg.defaultViewport
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    console.log(`📍 Navigating to ${previewUrl}...`);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    // Take initial screenshot
    const initialScreenshot = await page.screenshot({ fullPage: false });
    steps.push({
      description: 'Initial page load',
      screenshot: initialScreenshot.toString('base64')
    });

    // Create a test helper object that captures screenshots
    const testHelpers = {
      page,
      async captureStep(description: string) {
        console.log(`📸 Capturing: ${description}`);
        const screenshot = await page.screenshot({ fullPage: false });
        steps.push({
          description,
          screenshot: screenshot.toString('base64')
        });
      }
    };

    // Execute the test code in a sandboxed way
    // The test code should use the helpers provided
    const testFunction = new Function('helpers', testCode);
    await testFunction(testHelpers);

    console.log(`✅ Test executed successfully with ${steps.length} steps captured`);

    return {
      success: true,
      steps
    };

  } catch (error: any) {
    console.error('❌ Browser test error:', error);

    // Try to capture error state if browser is still running
    if (browser) {
      try {
        const pages = await browser.contexts()[0]?.pages();
        if (pages && pages.length > 0) {
          const errorScreenshot = await pages[0].screenshot({ fullPage: false });
          steps.push({
            description: `Error occurred: ${error.message}`,
            screenshot: errorScreenshot.toString('base64')
          });
        }
      } catch (screenshotError) {
        console.error('Could not capture error screenshot:', screenshotError);
      }
    }

    return {
      success: false,
      steps,
      error: error.message
    };

  } finally {
    if (browser) {
      await browser.close();
      console.log('🔒 Browser closed');
    }
  }
}

/**
 * Generate test code template for Claude to fill in
 */
export function getTestCodeTemplate(requirements: string): string {
  return `
// Test Code Template - Claude should customize this based on requirements
// Available: helpers.page (Playwright Page), helpers.captureStep(description)

const { page, captureStep } = helpers;

// Example test flow:
${requirements.includes('modal') || requirements.includes('popup') ? `
// Open modal
await page.click('selector-for-modal-trigger');
await page.waitForTimeout(500);
await captureStep('Modal opened');

// Click outside modal
await page.click('body', { position: { x: 10, y: 10 } });
await page.waitForTimeout(500);
await captureStep('Clicked outside modal');
` : ''}

${requirements.includes('button') || requirements.includes('click') ? `
// Click button and verify result
await page.click('selector-for-button');
await page.waitForTimeout(500);
await captureStep('After button click');
` : ''}

// Add more steps based on requirements...
await captureStep('Final state');
`.trim();
}
