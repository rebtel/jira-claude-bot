// Validation response interface
export interface ValidationResult {
  valid: boolean;
  reasoning: string;
  missing_information?: string[];
}

// Review response interface
export interface ReviewResult {
  approved: boolean;
  summary: string;
  issues: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    file: string;
    issue: string;
    suggestion: string;
  }>;
  overall_feedback: string;
}

// GitHub validation result
export interface GitHubValidationResult {
  success: boolean;
  summary: string;
  details: string;
}
