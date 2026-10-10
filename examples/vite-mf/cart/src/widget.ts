// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

declare const __VERSION__: string;

export function mount(el: HTMLElement) {
  el.dataset.version = __VERSION__;
  el.innerHTML = '';
  const button = document.createElement('button');
  let items = 0;
  const render = () => (button.textContent = `Cart ${__VERSION__}: ${items} items`);
  button.onclick = () => {
    items++;
    render();
  };
  render();
  el.append(button);
}
