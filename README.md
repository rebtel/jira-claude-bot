# Jira Claude Bot

Automatically implements Jira tickets using Claude Agent SDK and creates GitHub PRs.

## Architecture

```
Jira Assignment → Webhook → Vercel Function → Claude Agent SDK
                                                     ↓
                                            MCP Servers
                                            ├─ Atlassian (Jira)
                                            └─ GitHub (PR creation)
```

## Setup Instructions

### 1. Deploy to Vercel

```bash
# Install dependencies
npm install

# Install Vercel CLI
npm i -g vercel

# Login to Vercel
vercel login

# Deploy
vercel

# Add environment variables
vercel env add ANTHROPIC_API_KEY
vercel env add GITHUB_TOKEN
vercel env add ATLASSIAN_API_TOKEN
vercel env add JIRA_WEBHOOK_SECRET
vercel env add DEFAULT_REPO

# Deploy to production
vercel --prod
```

Your webhook URL will be: `https://your-project.vercel.app/api/jira-webhook`

### 2. Get Required Tokens

**Anthropic API Key:**
- Go to: https://console.anthropic.com/
- Create new API key

**GitHub Token:**
- Go to: https://github.com/settings/tokens
- Generate new token (classic) with `repo` scope

**Atlassian API Token:**
- Go to: https://id.atlassian.com/manage-profile/security/api-tokens
- Create API token

### 3. Create 'claude-code' Label in Jira

1. Go to your **Jira project** → **Project settings** → **Issues** → **Labels**
2. Create a new label: `claude-code`

### 4. Set Up Jira Automation Rule

1. Go to your **Jira project** → **Project settings** → **Automation**
2. Click **Create rule**
3. Configure:

   **Trigger:** "Issue updated"

   **Condition:** "Issue fields condition"
   - Field: `Labels`
   - Condition: `includes`
   - Value: `claude-code`

   **Action:** "Send web request"
   - Webhook URL: `https://your-project.vercel.app/api/jira-webhook`
   - HTTP method: `POST`
   - Webhook body: `Issue data`
   - Headers:
     ```
     X-Webhook-Secret: your-webhook-secret-here
     ```

4. **Name the rule** and **Turn it on**

### 5. Test with a Ticket

Create a Jira ticket with this format:

```
Title: Add dark mode toggle to settings page

Description:
repo: your-org/your-repo

Implement a dark mode toggle in the settings page.

Requirements:
- Add a toggle switch component
- Save preference to localStorage
- Apply dark theme styles when enabled
```

Then **add the `claude-code` label**!

## How It Works

1. **Add Label**: You add the `claude-code` label to a ticket
2. **Webhook Trigger**: Jira automation sends webhook to Vercel
3. **Vercel Function**: Receives webhook, parses ticket details
4. **Claude Agent**: Uses tools to:
   - Explore codebase and read relevant files
   - Create branch and make changes
   - Request AI code review
   - Make revisions if needed
   - Open pull request
   - Update Jira with PR link

## Cost Estimate

- **Vercel**: Free tier covers most usage
- **Anthropic API**: ~$0.10-1.00 per ticket
- **MCPs**: Free

## Troubleshooting

**Check Vercel logs:**
```bash
vercel logs
```

**Test webhook locally:**
```bash
vercel dev
# Then use ngrok or similar to expose localhost
```

**Verify environment variables:**
```bash
vercel env ls
```

## Features

✅ Label-based triggering - just add `claude-code` label to any ticket
✅ Multi-repository support - specify different repos per ticket
✅ Ticket validation - AI checks if requirements are clear
✅ **AI code review** - Second AI agent reviews changes before PR
✅ **Revision loop** - Automatically fixes issues found in review
✅ Automatic branch creation
✅ Pull request with AI review summary
✅ Updates Jira ticket with PR link
✅ **Zero setup required** - Works with any repository immediately

## 🎯 Multi-Stage Quality Process

1. **Ticket Validation** - AI validates requirements are clear
2. **Code Implementation** - Primary agent makes changes
3. **AI Code Review** - Reviewer agent analyzes changes
4. **Revision Loop** - Fixes issues if needed
5. **PR Creation** - Only after review passes

## Security Notes

- Webhook secret verification (optional but recommended)
- All tokens stored as Vercel environment variables
- OAuth authentication for MCP servers
- Isolated execution per request
