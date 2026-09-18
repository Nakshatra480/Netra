import { fetchSettlements } from './apiClient.js';
import { uploadReceipt } from './receiptUpload.js';

const token = window.localStorage.getItem('session');
fetchSettlements(token).then((settlements) => {
  document.querySelector('#root').textContent = `${settlements.length} settlements`;
});

document.querySelector('#receipt')?.addEventListener('change', (event) => {
  uploadReceipt(event.target.files[0]);
});
