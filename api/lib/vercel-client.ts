import { Octokit } from '@octokit/rest';

export interface VercelDeployment {
  url: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
}

/**
 * Wait for a Vercel preview deployment to be ready for a given PR
 * Parses Vercel bot's comment to get the preview URL
 */
export async function waitForVercelDeployment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  maxWaitMinutes: number = 5
): Promise<string | null> {
  const maxAttempts = (maxWaitMinutes * 60) / 10; // Check every 10 seconds
  let attempts = 0;

  console.log(`⏳ Waiting for Vercel preview deployment for PR #${prNumber}...`);

  while (attempts < maxAttempts) {
    try {
      // Get all comments on the PR
      const { data: comments } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100
      });

      if (attempts === 0) {
        console.log(`📋 Found ${comments.length} comment(s) on PR #${prNumber}`);
      }

      // Look for Vercel bot comment that indicates deployment is COMPLETED/READY
      const vercelComment = comments.find(comment => {
        if (!(comment.user?.login === 'vercel' || comment.user?.login === 'vercel[bot]' || comment.user?.type === 'Bot')) {
          return false;
        }

        const body = comment.body || '';

        // Look for indicators that deployment is COMPLETE and READY
        // Not just "deploying" or "building" status
        return (
          body.includes('Deployment has completed') ||
          body.includes('Successfully deployed') ||
          (body.includes('deployed') && body.includes('Preview') && !body.includes('Building')) ||
          body.includes('Ready')
        );
      });

      if (vercelComment && vercelComment.body) {
        console.log('🤖 Found Vercel bot comment');
        if (attempts === 0) {
          console.log('💬 Comment body:', vercelComment.body.substring(0, 500));
        }

        const repoName = repo.toLowerCase();

        // Strategy 1: Look for markdown link with "Preview – {repo-name}" text
        // Format: [Preview – rebtel-web](https://url)
        const previewLinkPattern = new RegExp(`\\[Preview\\s*[–-]\\s*${repo}\\]\\((https:\\/\\/[^\\)]+)\\)`, 'i');
        const previewLinkMatch = vercelComment.body.match(previewLinkPattern);

        if (previewLinkMatch && previewLinkMatch[1]) {
          console.log(`✅ Found preview URL via markdown link pattern: ${previewLinkMatch[1]}`);
          console.log('⏳ Waiting 10s to ensure deployment is fully ready...');
          await new Promise(resolve => setTimeout(resolve, 10000));
          return previewLinkMatch[1];
        }

        // Strategy 2: Look for HTML link with "Preview – {repo-name}" text
        // Format: <a href="https://url">Preview – rebtel-web</a>
        const htmlLinkPattern = new RegExp(`<a[^>]*href=["'](https:\\/\\/[^"']+)["'][^>]*>Preview\\s*[–-]\\s*${repo}<\\/a>`, 'i');
        const htmlLinkMatch = vercelComment.body.match(htmlLinkPattern);

        if (htmlLinkMatch && htmlLinkMatch[1]) {
          console.log(`✅ Found preview URL via HTML link pattern: ${htmlLinkMatch[1]}`);
          console.log('⏳ Waiting 10s to ensure deployment is fully ready...');
          await new Promise(resolve => setTimeout(resolve, 10000));
          return htmlLinkMatch[1];
        }

        // Strategy 3: Fallback - extract all URLs and filter
        console.log('🔍 Trying fallback URL extraction...');
        const urlMatches = vercelComment.body.match(/https:\/\/[^\s\)\]<>"]+/g);

        if (urlMatches && urlMatches.length > 0) {
          console.log(`🔗 Found ${urlMatches.length} deployment URL(s):`, urlMatches);

          // First, filter out obvious non-deployment URLs (GitHub, avatars, etc.)
          const deploymentUrls = urlMatches.filter(url => {
            const urlLower = url.toLowerCase();
            if (urlLower.includes('github.com') ||
                urlLower.includes('githubusercontent.com') ||
                urlLower.includes('avatar')) {
              return false;
            }
            return true;
          });

          console.log(`🔍 After filtering, ${deploymentUrls.length} potential deployment URL(s)`);

          if (deploymentUrls.length === 0) {
            console.log('⚠️ No deployment URLs found after filtering');
          } else {
            // Look for URL not containing "storybook"
            const mainDeployment = deploymentUrls.find(url =>
              !url.toLowerCase().includes('storybook')
            );

            if (mainDeployment) {
              console.log(`✅ Using first non-Storybook deployment: ${mainDeployment}`);
              return mainDeployment;
            }

            console.log('⚠️ Only found Storybook deployments');
          }
        }
      }

      attempts++;
      console.log(`⏳ Attempt ${attempts}/${maxAttempts} - Vercel comment not found yet, waiting 10s...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

    } catch (error) {
      console.error('Error checking deployment status:', error);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  console.log('❌ Timeout waiting for Vercel deployment');
  return null;
}
