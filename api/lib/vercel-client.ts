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
        (comment.user?.login === 'vercel[bot]' || comment.user?.type === 'Bot') &&
        comment.body?.includes('Successfully deployed')
      );

      if (vercelComment && vercelComment.body) {
        console.log('🤖 Found Vercel bot comment');

        // Extract preview URL from comment
        // Vercel comments typically have format: [Visit Preview](https://preview-url.vercel.app)
        const urlMatches = vercelComment.body.match(/https:\/\/[^\s\)]+\.vercel\.app[^\s\)]*/g);

        if (urlMatches && urlMatches.length > 0) {
          console.log(`🔗 Found ${urlMatches.length} deployment URL(s)`);

          // Filter to get the main deployment (repo name), not storybook or other deployments
          const repoName = repo.toLowerCase();
          const mainDeployment = urlMatches.find(url => {
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
            console.log(`✅ Found main deployment: ${mainDeployment}`);
            return mainDeployment;
          }

          // Otherwise, take the first non-storybook deployment
          const firstNonStorybook = urlMatches.find(url =>
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
