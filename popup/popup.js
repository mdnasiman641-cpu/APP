(async () => {
  const $ = (id) => document.getElementById(id);

  $('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let status = null;
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: 'PANEL_STATUS' });
  } catch {
    status = null; // no content script on this tab
  }

  if (!status) {
    $('status').textContent = 'Open the Meta Business Suite bulk Reel upload page to use the assistant.';
    return;
  }

  $('status').textContent = status.connected
    ? `Connected · ${status.running ? 'running' : status.phase}`
    : 'This Facebook page is not recognised as the bulk Reel page.';
  $('counters').hidden = false;
  for (const key of ['detected', 'applied', 'scheduled', 'errors']) $(key).textContent = status.counters[key];

  $('showPanel').hidden = false;
  $('showPanel').addEventListener('click', async () => {
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PANEL' });
    window.close();
  });
})();
