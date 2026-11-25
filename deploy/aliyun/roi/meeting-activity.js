(() => {
  const chip = document.querySelector('[data-weitong-presence]');
  if (!chip) return;
  const title = chip.querySelector('strong');
  const detail = chip.querySelector('span');
  let busy = false;
  async function refresh() {
    if (busy || document.hidden) return;
    if (typeof isSuperAdminUser !== 'function' || !isSuperAdminUser()) { chip.hidden = true; return; }
    chip.hidden = false;
    busy = true;
    try {
      const r = await fetch('/zwt-meeting/api/v1/rooms/operations/activity', {headers: authHeaders(), cache: 'no-store', signal: AbortSignal.timeout(6000)});
      if (!r.ok) throw new Error(String(r.status));
      const state = await r.json();
      if (!Array.isArray(state.rooms) || !Number.isFinite(state.members) || Math.abs(Date.now()/1000 - state.sampledAt) > 90) throw new Error('stale');
      title.textContent = state.maintenance ? '中卫通公网会议 · 维护中' : state.idle ? '中卫通公网会议 · 当前无人在会' : '中卫通公网会议 · 使用中，请暂缓更新';
      detail.textContent = state.rooms.map(row => '会议 ' + row.meetingNumber + ' · ' + row.members + ' 人 · ' + row.publications + ' 路媒体' + (row.names.length ? ' · '+row.names.join('、') : '')).join('　/　') || '上次核对 ' + new Date(state.sampledAt*1000).toLocaleTimeString();
    } catch {
      title.textContent = '中卫通公网会议 · 状态未知';
      detail.textContent = '暂缓更新，点击重新检查';
    } finally { busy = false; }
  }
  chip.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
  setInterval(refresh, 5000);
})();
