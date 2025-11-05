# Quick Start Guide

## What This Does

Assigns Jira ticket to bot → Bot makes code changes → Creates GitHub PR automatically

**No local machine needed!** Runs on Anthropic's infrastructure via Vercel.

## Setup in 5 Steps

### 1. Install & Deploy

```bash
cd jira-claude-bot
npm install
npm i -g vercel
vercel login
verbal
```



### 2. Add Environment Variables

```bash
vercel env add ANTHROPIC_API_KEY          # From https://console.anthropic.com/
vercel env add GITHUB_TOKEN               # From https://github.com/settings/tokens
vercel env add ATLASSIAN_API_TOKEN        # From https://id.atlassian.com/manage-profile/security/api-tokens
vercel env add JIRA_WEBHOOK_SECRET        # Make up a secret string (e.g., ee6aeca76559b355b5e343f342546140)
vercel env add DEFAULT_REPO               # e.g., your-org/your-repo
```

### 3. Deploy to Production

```bash
vercel --prod
```

Note your webhook URL: `https://your-project.vercel.app/api/jira-webhook`

### 4. Create 'claude-code' Label in Jira

1. Go to your **Jira project** → **Project settings** → **Issues** → **Labels**
2. Create a new label: `claude-code`

### 5. Create Jira Automation

1. **Project settings** → **Automation** → **Create rule**
2. **Trigger**: Issue updated
3. **Condition**: Issue fields condition
   - Field: `Labels`
   - Condition: `includes`
   - Value: `claude-code`
4. **Action**: Send web request
   - URL: Your Vercel webhook URL (e.g., `https://jira-claude-a1r5g2mt4.reblab.net/api/jira-webhook`)
   - Method: POST
   - Body: Issue data
   - Header: `X-Webhook-Secret: [your secret]`
5. **Turn it on**

## Test It!

Create a Jira ticket:

```
Title: Add user profile page

Description:
repo: your-org/your-repo

Create a basic user profile page with:
- Avatar display
- Name and email fields
- Edit button
```

**Add the `claude-code` label** → Watch the magic happen! ✨

## Check Logs

```bash
vercel logs
```

## What Gets Created

- New branch: `ticket-key-implementation`
- Code changes based on ticket
- Pull request with Jira reference
- Jira comment with PR link

## Cost Per Ticket

~$0.10 - $1.00 depending on complexity
