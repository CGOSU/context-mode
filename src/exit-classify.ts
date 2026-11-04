/**
 * Classify non-zero exit codes for ctx_execute / ctx_execute_file.
 *
 * A shell's exit 1 can mean no matches or a failed build/test. Output alone
 * cannot distinguish them: preserve the actual failure and both streams.
 */
export interface ExitClassification {
  isError: boolean;
  output: string;
}

export function classifyNonZeroExit(params: {
  language: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): ExitClassification {
  const { exitCode, stdout, stderr } = params;

  return {
    isError: true,
    output: `Exit code: ${exitCode}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
  };
}
