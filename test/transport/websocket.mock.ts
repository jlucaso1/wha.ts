import { mock, type Mock } from "bun:test";

class MockWebSocket extends EventTarget {
    static instances: MockWebSocket[] = [];
    readyState: number = 0; // CONNECTING
    url: string;
    binaryType: string = "arraybuffer";

    // Mock functions for inspection
    send: Mock<(data: any) => void>;
    close: Mock<(code?: number, reason?: string) => void>;
    _triggerOpen: () => void;
    _triggerMessage: (data: ArrayBuffer) => void;
    _triggerError: (error: Error) => void;
    _triggerClose: (code: number, reason: string) => void;

    constructor(url: string) {
        super();
        this.url = url;
        this.send = mock();
        this.close = mock(() => {
            this.readyState = 2; // CLOSING
            // Simulate async close
            setTimeout(() => this._triggerClose(1000, "Normal Closure"), 10);
        });

        this._triggerOpen = () => {
            this.readyState = 1; // OPEN
            this.dispatchEvent(new Event("open"));
        };
        this._triggerMessage = (data: ArrayBuffer) => {
            if (this.readyState !== 1) return;
            this.dispatchEvent(new MessageEvent("message", { data }));
        };
        this._triggerError = (error: Error) => {
            this.readyState = 3; // CLOSED
            this.dispatchEvent(new CustomEvent("error", { detail: error })); // ErrorEvent is tricky
            this.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "Error" }));
            MockWebSocket.instances = MockWebSocket.instances.filter(i => i !== this);
        };
        this._triggerClose = (code: number, reason: string) => {
            this.readyState = 3; // CLOSED
            this.dispatchEvent(new CloseEvent("close", { code, reason }));
            MockWebSocket.instances = MockWebSocket.instances.filter(i => i !== this);
        };

        MockWebSocket.instances.push(this);
        // Simulate async connection
        setTimeout(() => this._triggerOpen(), 10);
    }
}
// Replace global WebSocket
declare var globalThis: { WebSocket: typeof MockWebSocket };
globalThis.WebSocket = MockWebSocket;

export { MockWebSocket };