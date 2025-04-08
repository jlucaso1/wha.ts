import { vi } from "vitest";
import type { MockInstance } from "vitest";

class MockWebSocket extends EventTarget {
    static instances: MockWebSocket[] = [];
    readyState: number = 0;
    url: string;
    binaryType: string = "arraybuffer";

    send: MockInstance<(data: any) => void>;
    close: MockInstance<(code?: number, reason?: string) => void>;

    _triggerOpen: () => void;
    _triggerMessage: (data: ArrayBuffer) => void;
    _triggerError: (error: Error) => void;
    _triggerClose: (code: number, reason: string) => void;

    constructor(url: string) {
        super();
        this.url = url;
        this.send = vi.fn();
        this.close = vi.fn(() => {
            if (this.readyState === 3) return;
            this.readyState = 2;
            setTimeout(() => this._triggerClose(1000, "Normal Closure"), 10);
        });

        this._triggerOpen = () => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        };
        this._triggerMessage = (data: ArrayBuffer) => {
            if (this.readyState !== 1) return;
            this.dispatchEvent(new MessageEvent("message", { data }));
        };
        this._triggerError = (error: Error) => {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.dispatchEvent(new CustomEvent("error", { detail: error }));
            this.dispatchEvent(
                new CloseEvent("close", {
                    code: 1006,
                    reason: "Abnormal Closure",
                }),
            );
            MockWebSocket.instances = MockWebSocket.instances.filter((i) =>
                i !== this
            );
        };
        this._triggerClose = (code: number, reason: string) => {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.dispatchEvent(new CloseEvent("close", { code, reason }));
            MockWebSocket.instances = MockWebSocket.instances.filter((i) =>
                i !== this
            );
        };

        MockWebSocket.instances.push(this);
        setTimeout(() => {
            if (this.readyState === 0) {
                this._triggerOpen();
            }
        }, 10);
    }
}

declare var globalThis: { WebSocket: typeof MockWebSocket & typeof WebSocket };
// @ts-ignore
globalThis.WebSocket = MockWebSocket;

export { MockWebSocket };
