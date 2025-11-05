# GitHub Actions Workflow Templates

This directory contains workflow templates that need to be added to your target repositories for the Jira-Claude bot to work properly.

## 📋 Required Setup

### 1. Add the Validation Workflow to Your Repository

The bot uses GitHub Actions to validate code changes before creating PRs. Each repository needs this workflow file.

**Steps:**

1. In your target repository (e.g., `your-org/your-repo`), create the directory:
   ```bash
   mkdir -p .github/workflows
   ```

2. Copy the workflow template:
   ```bash
   cp templates/claude-validate.yml your-repo/.github/workflows/claude-validate.yml
   ```

3. Customize the workflow for your project:
   - **Node version**: Change `node-version: '18'` to match your project
   - **Build command**: Update the build step to match your project's build command
   - **Test command**: Update the test step to match your project's test command

4. Commit and push:
   ```bash
   git add .github/workflows/claude-validate.yml
   git commit -m "Add Claude bot validation workflow"
   git push
   ```

### 2. Ensure GitHub Actions is Enabled

- Go to your repository settings
- Navigate to **Actions** → **General**
- Ensure "Allow all actions and reusable workflows" is enabled
- Save changes

### 3. Configure Repository Secrets (if needed)

If your build/tests require environment variables:

1. Go to repository **Settings** → **Secrets and variables** → **Actions**
2. Add any required secrets (e.g., API keys, tokens)

## 🔧 Customization Examples

### For a TypeScript Project with Vite:

```yaml
- name: Run build
  if: inputs.test_type == 'build' || inputs.test_type == 'both'
  run: npm run build

- name: Run tests
  if: inputs.test_type == 'test' || inputs.test_type == 'both'
  run: npm run test
```

### For a Next.js Project:

```yaml
- name: Run build
  if: inputs.test_type == 'build' || inputs.test_type == 'both'
  run: npm run build

- name: Run tests
  if: inputs.test_type == 'test' || inputs.test_type == 'both'
  run: npm run test:ci
```

### For a Project with Only TypeScript Checking:

```yaml
- name: Run build
  if: inputs.test_type == 'build' || inputs.test_type == 'both'
  run: npx tsc --noEmit

- name: Run tests
  if: inputs.test_type == 'test' || inputs.test_type == 'both'
  run: npm test
```

## ⚠️ Important Notes

1. **Workflow must be named `claude-validate.yml`** - The bot looks for this specific filename
2. **Workflow must be on the default branch** - GitHub Actions requires the workflow file to exist on the default branch before it can be triggered
3. **Test the workflow manually** - After adding it, try running it manually from the Actions tab to ensure it works

## 🧪 Testing the Workflow

### Manual Test:

1. Go to your repository on GitHub
2. Click **Actions** tab
3. Select "Claude Code Validation" workflow
4. Click "Run workflow"
5. Select a branch and validation type
6. Click "Run workflow"

If it runs successfully, the bot will be able to use it!

## 🚫 Troubleshooting

### "Workflow file not found" error

- Make sure the file is at `.github/workflows/claude-validate.yml`
- Ensure the workflow is committed to the default branch (usually `main` or `master`)
- Wait a few minutes after pushing for GitHub to recognize the workflow

### Build or tests fail

- Check the workflow logs in the Actions tab
- Update the build/test commands in the workflow file
- Ensure all dependencies are properly listed in `package.json`

### Workflow times out

- GitHub Actions has a 6-hour timeout by default
- If your build/tests take longer, consider splitting them or optimizing
- The bot waits up to 5 minutes for results

## 📚 Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [Manual Triggering (workflow_dispatch)](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch)
