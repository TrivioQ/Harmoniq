declare const __VERSION__: string;

export function mount(el: HTMLElement) {
  el.dataset.version = __VERSION__;
  el.textContent = `Hello from greeting ${__VERSION__}`;
}
