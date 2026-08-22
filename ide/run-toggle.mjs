export const RUN_TOGGLE_VIEWS = Object.freeze({
  idle: Object.freeze({ label: '実行', icon: 'play' }),
  running: Object.freeze({ label: '停止', icon: 'stop' }),
});

export function runToggleView(state) {
  const view = RUN_TOGGLE_VIEWS[state];
  if (!view) throw new TypeError(`不明な実行状態です: ${state}`);
  return view;
}

export function renderRunToggle(button, state) {
  const view = runToggleView(state);
  const label = button.querySelector('.toolbar-label');
  const play = button.querySelector('[data-run-icon="play"]');
  const stop = button.querySelector('[data-run-icon="stop"]');
  if (!label || !play || !stop) throw new Error('実行トグルの表示要素が足りません');
  label.textContent = view.label;
  button.setAttribute('aria-label', view.label);
  button.title = view.label;
  button.dataset.state = state;
  return view;
}
