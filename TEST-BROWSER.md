# Local Browser Testing

Test the browser testing flow locally without going through Jira.

## Setup

1. Make sure you have your environment variable set:
```bash
export ANTHROPIC_API_KEY=your_key_here
```

2. Install Playwright browsers (first time only):
```bash
npx playwright install chromium
```

## Usage

1. **Edit `test-browser.mjs`** and update:
   - `PREVIEW_URL` - Set to your actual Vercel preview URL
   - `JIRA_DESCRIPTION` - Write the requirements you want to test

2. **Run the test:**
```bash
node test-browser.mjs
```

## What it does

1. Generates Playwright test code based on your requirements
2. Executes the test in a headless browser
3. Captures screenshots at each step
4. Has Claude review the screenshots visually
5. Returns APPROVED or NEEDS_REVISION

## Example Output

```
🧪 Testing browser flow locally

Preview URL: https://rebtel-web-git-fe-3721-implementation.reblab.net
Requirements: Add a promotional banner to products page
============================================================

🤖 Asking Claude to generate test scenario...
📝 Generated test code:

await helpers.captureStep('Homepage loaded');
await helpers.page.click('[href*="products"]');
await helpers.captureStep('Products page');

============================================================

🎭 Executing browser test...
🌐 Launching browser...
📸 Captured 3 test steps

============================================================

👀 Claude reviewing test results...

📋 Visual Review Result:

APPROVED: The promotional banner is visible at the top of the
products page and includes the "20% off" text as specified...

============================================================

✅ Test passed!
```

## Tips

- Use an actual preview URL from a recent PR
- Keep requirements simple and focused
- Check the generated test code to debug issues
- Screenshots are captured but not saved (only sent to Claude)
