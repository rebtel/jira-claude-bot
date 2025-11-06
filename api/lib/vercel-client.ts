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

      // Look for Vercel bot comment
      const vercelComment = comments.find(comment =>
        (comment.user?.login === 'vercel' || comment.user?.login === 'vercel[bot]' || comment.user?.type === 'Bot') &&
        (comment.body?.includes('deployed') || comment.body?.includes('Preview'))
      );

      if (vercelComment && vercelComment.body) {
        console.log('🤖 Found Vercel bot comment');
        if (attempts === 0) {
          console.log('💬 Comment body:', vercelComment.body.substring(0, 200));
        }

        // Extract preview URL from comment
        // Match URLs from various formats: markdown links, HTML, or plain URLs
        // Support both .vercel.app and custom domains
        const urlMatches = vercelComment.body.match(/https:\/\/[^\s\)\]<>"]+/g);

        if (urlMatches && urlMatches.length > 0) {
          console.log(`🔗 Found ${urlMatches.length} deployment URL(s):`, urlMatches);

          // Filter to get the main deployment (repo name), not storybook or other deployments
          const repoName = repo.toLowerCase();

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
            return null;
          }

          // Look for URL containing repo name (not storybook)
          const mainDeployment = deploymentUrls.find(url => {
            const urlLower = url.toLowerCase();
            // Skip storybook deployments
            if (urlLower.includes('storybook')) {
              console.log(`⏭️  Skipping Storybook deployment: ${url}`);
              return false;
            }
            // Prefer URLs that contain the repo name
            if (urlLower.includes(repoName)) {
              return true;
            }
            return false;
          });

          // If we found a repo-specific deployment, use it
          if (mainDeployment) {
            console.log(`✅ Found main deployment with repo name: ${mainDeployment}`);
            return mainDeployment;
          }

          // Otherwise, take the first non-storybook deployment
          const firstNonStorybook = deploymentUrls.find(url =>
            !url.toLowerCase().includes('storybook')
          );

          if (firstNonStorybook) {
            console.log(`✅ Using first non-Storybook deployment: ${firstNonStorybook}`);
            return firstNonStorybook;
          }

          console.log('⚠️ Only found Storybook deployments, waiting for main deployment...');
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
