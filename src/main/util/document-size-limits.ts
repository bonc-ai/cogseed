/** Shared source-byte limits for attachments and bounded result extraction. */
export const MAX_BYTES_DOCX = 20 * 1024 * 1024;
export const MAX_BYTES_OFFICE = 50 * 1024 * 1024;
export const MAX_BYTES_PDF = 100 * 1024 * 1024;

export function richDocumentMaxBytes(extension: string): number | undefined {
  switch (extension.toLowerCase()) {
    case '.pdf': return MAX_BYTES_PDF;
    case '.docx': case '.docm': return MAX_BYTES_DOCX;
    case '.xlsx': case '.xlsm': case '.pptx': case '.pptm': return MAX_BYTES_OFFICE;
    default: return undefined;
  }
}
