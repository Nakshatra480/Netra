import { fetchSettlements } from './apiClient.js';

const token = window.localStorage.getItem('session');
fetchSettlements(token).then((settlements) => {
  document.querySelector('#root').textContent = `${settlements.length} settlements`;
});
