import type { FileMeta } from "@silverbulletmd/silverbullet/type/index";
import { expect, test, vi } from "vitest";
import type { Client } from "../../client.ts";
import { fileMetaToDocumentMeta } from "../../space.ts";
import { spaceReadSyscalls } from "./space.ts";

async function activityUrl(...args: (number | undefined)[]): Promise<string> {
  const authenticatedFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ commits: [1], topFiles: [] }), {
        status: 200,
      }),
  );
  const client = {
    bootConfig: { revisions: "managed" },
    httpSpacePrimitives: { url: "http://host/.fs", authenticatedFetch },
  } as unknown as Client;
  const syscall = spaceReadSyscalls(client)["space.getActivity"] as any;
  const result = await syscall.callback({}, ...args);
  expect(result).toEqual({ commits: [1], topFiles: [] });
  return authenticatedFetch.mock.calls[0][0];
}

test("space.getActivity builds the _activity URL with only the given params", async () => {
  expect(await activityUrl(10, undefined, 3)).toMatch(
    /\/\.revisions\/_activity\?since=10&top=3$/,
  );
  expect(await activityUrl()).toMatch(/\/\.revisions\/_activity$/);
});

test.each(["disabled", undefined])(
  "revision reads skip HTTP when boot config reports %s revisions",
  async (revisions) => {
    const authenticatedFetch = vi.fn(async () => Response.json({}));
    const client = {
      bootConfig: { revisions },
      httpSpacePrimitives: { url: "http://host/.fs", authenticatedFetch },
    } as unknown as Client;
    const syscalls = spaceReadSyscalls(client);
    for (const name of ["space.getActivity", "space.getGitSyncStatus"]) {
      const syscall = syscalls[name] as any;
      await expect(syscall.callback({})).rejects.toMatchObject({ status: 404 });
    }
    expect(authenticatedFetch).not.toHaveBeenCalled();
  },
);

test.each(["managed", "unmanaged"])(
  "Git sync status still loads with %s revisions in a read-only space",
  async (revisions) => {
    const authenticatedFetch = vi.fn(async () =>
      Response.json({ enabled: false }),
    );
    const client = {
      bootConfig: { revisions, readOnly: true },
      httpSpacePrimitives: { url: "http://host/.fs", authenticatedFetch },
    } as unknown as Client;
    const syscall = spaceReadSyscalls(client)["space.getGitSyncStatus"] as any;
    expect(await syscall.callback({})).toEqual({ enabled: false });
    expect(authenticatedFetch.mock.calls).toHaveLength(1);
  },
);

function mergeSyscall(response: Response) {
  const authenticatedFetch = vi.fn(
    async (_url: string, _init: RequestInit) => response,
  );
  const client = {
    httpSpacePrimitives: { url: "http://x/sub/.fs", authenticatedFetch },
  } as unknown as Client;
  const syscall = spaceReadSyscalls(client)["space.mergeText"] as any;
  return {
    authenticatedFetch,
    merge: () => syscall.callback({}, "A\n", "B\n", "C\n"),
  };
}

test("space.mergeText posts the texts to /.merge", async () => {
  const { authenticatedFetch, merge } = mergeSyscall(
    Response.json({ status: "clean", text: "M\n" }),
  );
  expect(await merge()).toEqual({ status: "clean", text: "M\n" });
  const [url, init] = authenticatedFetch.mock.calls[0];
  expect(url).toBe("http://x/sub/.merge");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({
    base: "A\n",
    local: "B\n",
    remote: "C\n",
  });
});

test("space.mergeText returns nil for texts it can't merge", async () => {
  for (const status of [409, 413]) {
    const { merge } = mergeSyscall(new Response("no", { status }));
    expect(await merge(), String(status)).toBeNull();
  }
  const { merge } = mergeSyscall(new Response("bad", { status: 400 }));
  await expect(merge()).rejects.toThrow(/400/);
});

test("space.mergeText requires a server connection", async () => {
  const client = {} as unknown as Client;
  const syscall = spaceReadSyscalls(client)["space.mergeText"] as any;
  await expect(syscall.callback({}, "A\n", "B\n", "C\n")).rejects.toThrow(
    "This requires a connection to the server",
  );
});

const pic: FileMeta = {
  name: "Assets/pic.png",
  created: 1_700_000_000_000,
  lastModified: 1_700_000_100_000,
  contentType: "image/png",
  size: 5,
  perm: "rw",
};

function metaClient(listed: FileMeta | undefined): {
  client: Client;
  getDocumentMeta: ReturnType<typeof vi.fn>;
} {
  const getDocumentMeta = vi.fn(async (name: string) =>
    fileMetaToDocumentMeta({
      ...pic,
      name,
      lastModified: pic.lastModified + 1,
    }),
  );
  const client = {
    eventedSpacePrimitives: {
      unchangedListedFile: (name: string) =>
        listed && name === listed.name ? listed : undefined,
    },
    space: { getDocumentMeta },
  } as unknown as Client;
  return { client, getDocumentMeta };
}

test("document metadata is reused from the file listing", async () => {
  const { client, getDocumentMeta } = metaClient(pic);
  const syscalls = spaceReadSyscalls(client);
  const got = await (syscalls["space.getDocumentMeta"] as any).callback(
    {},
    pic.name,
  );
  expect(got).toEqual(fileMetaToDocumentMeta(pic));
  expect(getDocumentMeta).not.toHaveBeenCalled();

  const alias = await (syscalls["space.getAttachmentMeta"] as any).callback(
    {},
    pic.name,
  );
  expect(alias).toEqual(got);
  expect(getDocumentMeta).not.toHaveBeenCalled();
});

test("pages and files changed since the listing still hit the server", async () => {
  const { client, getDocumentMeta } = metaClient(pic);
  const syscalls = spaceReadSyscalls(client);
  await (syscalls["space.getDocumentMeta"] as any).callback({}, "Note.md");
  await (syscalls["space.getDocumentMeta"] as any).callback({}, "other.png");
  expect(getDocumentMeta).toHaveBeenCalledTimes(2);
  expect(getDocumentMeta).toHaveBeenNthCalledWith(1, "Note.md");
  expect(getDocumentMeta).toHaveBeenNthCalledWith(2, "other.png");
});
