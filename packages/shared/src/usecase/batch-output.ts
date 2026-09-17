const BATCH_OUTPUT_PATHS_PREFIX = "__kq_batch_output_paths__:";

export function batchOutputPathsDescriptor(descriptor: string): string {
  return `${BATCH_OUTPUT_PATHS_PREFIX}${descriptor}`;
}
