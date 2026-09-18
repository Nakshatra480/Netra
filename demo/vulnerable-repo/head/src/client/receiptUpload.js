import { clientConfig } from './config.js';

// Uploads a receipt directly from the browser to the receipts bucket.
export async function uploadReceipt(file) {
  const { accessKeyId, secretAccessKey } = clientConfig.uploadCredentials;

  return fetch(`https://receipts.s3.${clientConfig.region}.amazonaws.com/${file.name}`, {
    method: 'PUT',
    headers: {
      'x-amz-access-key': accessKeyId,
      'x-amz-secret-key': secretAccessKey,
    },
    body: file,
  });
}
