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

      // Find Vercel bot comment
      const vercelComment = comments.find(c => c.user?.login === 'vercel[bot]' || c.user?.login === 'vercel');

      if (vercelComment && vercelComment.body) {
        console.log(`🤖 Found Vercel comment (attempt ${attempts + 1})`);

        // Vercel embeds deployment data as base64 JSON in the comment
        // Format: [vc]: #signature:base64data
        const vcDataMatch = vercelComment.body.match(/\[vc\]:\s*#[^:]+:([A-Za-z0-9+/=]+)/);

        if (vcDataMatch && vcDataMatch[1]) {
          try {
            // Decode base64 payload
            const jsonData = Buffer.from(vcDataMatch[1], 'base64').toString('utf-8');
            const deploymentData = JSON.parse(jsonData);

            console.log(`📦 Decoded Vercel deployment data`);

            if (deploymentData.projects && Array.isArray(deploymentData.projects)) {
              console.log(`   Found ${deploymentData.projects.length} project(s)`);

              // Find the main project (not storybook)
              const mainProject = deploymentData.projects.find((p: any) => {
                const name = p.name?.toLowerCase() || '';
                return name === repo.toLowerCase() || (name.includes(repo.toLowerCase()) && !name.includes('storybook'));
              });

              if (mainProject) {
                console.log(`   Main project: ${mainProject.name}`);
                console.log(`   Status: ${mainProject.nextCommitStatus || 'unknown'}`);
                console.log(`   Preview URL: ${mainProject.previewUrl || 'none'}`);

                // Check if deployment is ready (DEPLOYED or READY, not PENDING or BUILDING)
                const readyStatuses = ['DEPLOYED', 'READY'];
                const status = mainProject.nextCommitStatus || '';

                if (readyStatuses.includes(status) && mainProject.previewUrl) {
                  const previewUrl = mainProject.previewUrl.startsWith('http')
                    ? mainProject.previewUrl
                    : `https://${mainProject.previewUrl}`;

                  console.log(`✅ Deployment ready!`);
                  console.log(`🔗 Preview URL: ${previewUrl}`);

                  // Small safety delay
                  console.log('⏳ Waiting 5s to ensure deployment is serving...');
                  await new Promise(resolve => setTimeout(resolve, 5000));

                  return previewUrl;
                } else {
                  console.log(`⏳ Deployment status: ${status} (waiting for DEPLOYED or READY)`);
                }
              } else {
                console.log(`⚠️ Could not find main project for repo: ${repo}`);
              }
            }
          } catch (parseError) {
            console.error('Failed to parse Vercel deployment data:', parseError);
          }
        } else {
          console.log('⚠️ Could not find Vercel data payload in comment');
        }
      } else {
        console.log(`⏳ No Vercel comment found yet (attempt ${attempts + 1})`);
      }

      attempts++;
      console.log(`⏳ Attempt ${attempts}/${maxAttempts} - No ready deployment found yet, waiting 10s...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

    } catch (error) {
      console.error('Error checking deployment status:', error);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  console.log('❌ Timeout waiting for Vercel deployment to be ready');
  return null;
}
