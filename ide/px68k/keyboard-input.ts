import { isRepeatableKey, KeyRepeater } from './key-repeat.ts';
import { keyboardEventToRetrok, RETROK } from './keyboard.ts';

export interface KeyboardInputOptions {
  target: HTMLElement;
  setKey: (retrok: number, down: boolean) => void;
  sendKeyMake: (retrok: number) => void;
  enabled: () => boolean;
}

/** フォーカス可能な実行画面だけからゲストへ物理キーを配送する。 */
export class KeyboardInputController {
  private readonly target: HTMLElement;
  private readonly setKey: KeyboardInputOptions['setKey'];
  private readonly enabled: KeyboardInputOptions['enabled'];
  private readonly repeater: KeyRepeater;
  private readonly pressed = new Map<string, number>();
  private readonly ownerWindow: Window | null;

  constructor(options: KeyboardInputOptions) {
    this.target = options.target;
    this.setKey = options.setKey;
    this.enabled = options.enabled;
    this.repeater = new KeyRepeater(options.sendKeyMake);
    this.ownerWindow = this.target.ownerDocument.defaultView;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
    this.ownerWindow?.addEventListener('blur', this.onBlur);
    this.target.ownerDocument.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private sourceFor(event: Pick<KeyboardEvent, 'code'>, retrok: number): string {
    return event.code ? `code:${event.code}` : `retrok:${retrok}`;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled()) return;
    const retrok = keyboardEventToRetrok(event);
    if (retrok === RETROK.UNKNOWN) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const source = this.sourceFor(event, retrok);
    if (this.pressed.has(source)) return;
    this.pressed.set(source, retrok);
    this.setKey(retrok, true);
    if (isRepeatableKey(retrok)) this.repeater.start(source, retrok);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const resolved = keyboardEventToRetrok(event);
    const source = this.sourceFor(event, resolved);
    const retrok = this.pressed.get(source);
    if (retrok === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.pressed.delete(source);
    this.repeater.stop(source);
    this.setKey(retrok, false);
  };

  private onBlur = (): void => this.releaseAll();

  private onVisibilityChange = (): void => {
    if (this.target.ownerDocument.hidden) this.releaseAll();
  };

  releaseAll(): void {
    this.repeater.stopAll();
    for (const retrok of this.pressed.values()) this.setKey(retrok, false);
    this.pressed.clear();
  }
}
