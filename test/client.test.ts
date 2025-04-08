import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryAuthState, WhaTSClient } from "../src/client";

vi.mock("../src/core/connection", () => ({
    ConnectionManager: vi.fn(() => ({
        connect: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        sendNode: vi.fn(async () => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })),
}));

vi.mock("../src/core/authenticator", () => ({
    Authenticator: vi.fn(() => ({
        initiateAuthentication: vi.fn(() => ({})),
        addEventListener: vi.fn((event: string, cb: (e: any) => void) => {
        }),
        removeEventListener: vi.fn(),
    })),
}));

let client: WhaTSClient;
let authState: MemoryAuthState;

beforeEach(() => {
    authState = new MemoryAuthState();
    client = new WhaTSClient({ auth: authState });
});

afterEach(() => {
    vi.restoreAllMocks();
});

test("constructor initializes components correctly", () => {
    expect(client).toBeDefined();
    expect(client.auth).toBe(authState);
});

test("connect calls ConnectionManager.connect", async () => {
    const connectMock = vi.mocked(client["conn"].connect);

    await client.connect();

    expect(connectMock).toHaveBeenCalledTimes(1);
});

test("logout calls ConnectionManager.close", async () => {
    const closeMock = vi.mocked(client["conn"].close);

    await client.logout();

    expect(closeMock).toHaveBeenCalledTimes(1);
});

test("logout with reason calls ConnectionManager.close with corresponding error", async () => {
    const closeMock = vi.mocked(client["conn"].close);
    const reason = "Test Reason";

    await client.logout(reason);

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith(new Error(reason));
});
