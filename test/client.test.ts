import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { WhaTSClient, MemoryAuthState } from "../src/client";
import { ConnectionManager } from "../src/core/connection";
import { Authenticator } from "../src/core/authenticator";

mock.module("../src/core/connection", () => ({
    ConnectionManager: mock(() => ({
        connect: mock(async () => {}),
        close: mock(async () => {}),
        sendNode: mock(async () => {}),
        addEventListener: mock(),
        removeEventListener: mock(),
    })),
}));
mock.module("../src/core/authenticator", () => ({
    Authenticator: mock(() => ({
        initiateAuthentication: mock(() => ({})),
        addEventListener: mock((event: string, cb: (e: any) => void) => {
        }),
        removeEventListener: mock(),
    })),
}));



beforeEach(() => {
    mock.restore();

    const client = new WhaTSClient({ auth: new MemoryAuthState() });


});

test("constructor initializes components", () => {
    const authState = new MemoryAuthState();
    const client = new WhaTSClient({ auth: authState });
    expect(client.auth).toBe(authState);
});

test("connect calls ConnectionManager.connect", async () => {
    const client = new WhaTSClient({ auth: new MemoryAuthState() });
    const connectMock = client['conn'].connect;

    await client.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
});

test("logout calls ConnectionManager.close", async () => {
    const client = new WhaTSClient({ auth: new MemoryAuthState() });
     const closeMock = client['conn'].close;

    await client.logout();

    expect(closeMock).toHaveBeenCalledTimes(1);
});

