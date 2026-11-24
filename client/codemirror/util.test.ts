import { EditorState } from "@codemirror/state";
import { BasenameIndex } from "@silverbulletmd/silverbullet/lib/resolve_path";
import { parseTransclusion } from "@silverbulletmd/silverbullet/lib/transclusion";
import { expect, test } from "vitest";
import type { Client, PageListSource } from "../client.ts";
import { buildExtendedMarkdownLanguage } from "../markdown_parser/parser.ts";
import { inlineEmbedRenderMode, widgetRenderMode } from "./util.ts";

function clientWith(state: {
  systemReady?: boolean;
  scriptsLoaded?: boolean;
  pageListSource?: PageListSource;
  renderWidgets?: boolean;
  fullIndexCompleted?: boolean;
  knownFilesLoaded?: boolean;
  files?: BasenameIndex;
}): Client {
  return {
    systemReady: state.systemReady ?? true,
    clientSystem: {
      scriptsLoaded: state.scriptsLoaded ?? true,
      knownFilesLoaded: state.knownFilesLoaded ?? false,
      allKnownFiles: state.files ?? new BasenameIndex(),
    },
    // A cold client: no index yet, page list from the plain file listing
    fullIndexCompleted: state.fullIndexCompleted ?? false,
    pageListSource: state.pageListSource ?? "listing",
    currentPath: () => "Notes/Index.md",
    currentName: () => "Notes/Index",
    currentPageMeta: () =>
      state.renderWidgets === undefined
        ? { name: "index" }
        : {
            name: "index",
            pageDecoration: { renderWidgets: state.renderWidgets },
          },
  } as unknown as Client;
}

const page = (text: string) =>
  EditorState.create({
    doc: text,
    extensions: [buildExtendedMarkdownLanguage()],
  });
const plain = page("Body");

test("widgets render from the fallback page list before the full index", () => {
  expect(widgetRenderMode(clientWith({}), plain)).toBe("ready");
});

test("widgets wait for the system, scripts and a page list", () => {
  expect(widgetRenderMode(clientWith({ systemReady: false }), plain)).toBe(
    "loading",
  );
  expect(widgetRenderMode(clientWith({ scriptsLoaded: false }), plain)).toBe(
    "loading",
  );
  expect(widgetRenderMode(clientWith({ pageListSource: "none" }), plain)).toBe(
    "loading",
  );
});

test("a page decoration can still disable widget rendering", () => {
  expect(widgetRenderMode(clientWith({ renderWidgets: false }), plain)).toBe(
    "disabled",
  );
  expect(
    widgetRenderMode(
      clientWith({ renderWidgets: false, systemReady: false }),
      plain,
    ),
  ).toBe("disabled");
});

test("before the index, the page's own frontmatter can disable widgets", () => {
  const optedOut = page(
    "---\npageDecoration:\n  renderWidgets: false\n---\n${1 + 1}",
  );
  expect(widgetRenderMode(clientWith({}), optedOut)).toBe("disabled");
  expect(
    widgetRenderMode(clientWith({}), page("---\ntags: x\n---\nBody")),
  ).toBe("ready");
  expect(widgetRenderMode(clientWith({}), page("---\n: [\n---\nBody"))).toBe(
    "ready",
  );
  // Once the page list is index-backed, the page meta is the authority
  expect(
    widgetRenderMode(clientWith({ pageListSource: "index" }), optedOut),
  ).toBe("ready");
});

const embed = (text: string) => {
  const transclusion = parseTransclusion(text);
  if (!transclusion) throw new Error(`not an embed: ${text}`);
  return transclusion;
};

function filesWith(...paths: string[]): BasenameIndex {
  const files = new BasenameIndex();
  for (const path of paths) files.add(path);
  return files;
}

// Cold client: system is up, but there is no page list and no index yet.
const cold = (extra?: Parameters<typeof clientWith>[0]) =>
  clientWith({
    pageListSource: "none",
    fullIndexCompleted: false,
    ...extra,
  });

test("markdown images render before the system, scripts and a page list", () => {
  const client = cold({ scriptsLoaded: false, systemReady: false });
  const image = embed("![cap](pic.png)");
  expect(inlineEmbedRenderMode(client, plain, image)).toBe("ready");
  expect(widgetRenderMode(client, plain)).toBe("loading");

  const nested = embed("![](../Assets/pic.png)");
  expect(inlineEmbedRenderMode(client, plain, nested)).toBe("ready");

  const remote = embed("![](https://example.com/pic.png)");
  expect(inlineEmbedRenderMode(client, plain, remote)).toBe("ready");
});

test("a document wikilink renders once the file listing can resolve it", () => {
  const files = filesWith("Assets/photo.png", "notes/dir/clip.mp4");
  const client = cold({ files, knownFilesLoaded: true });

  const image = embed("![[photo.png]]");
  expect(inlineEmbedRenderMode(client, plain, image)).toBe("ready");
  expect(image.url).toBe("Assets/photo.png");

  const clip = embed("![[dir/clip.mp4]]");
  expect(inlineEmbedRenderMode(client, plain, clip)).toBe("ready");
  expect(clip.url).toBe("notes/dir/clip.mp4");

  // A loaded listing with no match is the same miss as after the index
  const missing = embed("![[nope.png]]");
  expect(inlineEmbedRenderMode(client, plain, missing)).toBe("ready");
  expect(missing.url).toBe("nope.png");
});

test("an exact document path renders before the file listing arrives", () => {
  const client = cold({ knownFilesLoaded: false });
  const exact = embed("![[Assets/photo.png]]");
  expect(inlineEmbedRenderMode(client, plain, exact)).toBe("ready");

  // A bare name still needs the listing
  const bare = embed("![[photo.png]]");
  expect(inlineEmbedRenderMode(client, plain, bare)).toBe("loading");
});

test("a pdf or other non-page document does not wait for the index", () => {
  const files = filesWith("Files/spec.pdf");
  const client = cold({ files });
  const pdf = embed("![[spec.pdf|50%]]");
  expect(inlineEmbedRenderMode(client, plain, pdf)).toBe("ready");
  expect(pdf.url).toBe("Files/spec.pdf");
});

test("page transclusions follow widgetRenderMode, before and after the index", () => {
  const files = filesWith("Notes/Hello.md", "Deep/Other.md");
  const waiting = cold({ files, knownFilesLoaded: true });

  const pageEmbed = embed("![[Hello]]");
  expect(inlineEmbedRenderMode(waiting, plain, pageEmbed)).toBe(
    widgetRenderMode(waiting, plain),
  );
  expect(pageEmbed.url).toBe("Notes/Hello");
  expect(inlineEmbedRenderMode(waiting, plain, embed("![[Deep/Other]]"))).toBe(
    "loading",
  );
  expect(inlineEmbedRenderMode(waiting, plain, embed("![](Hello.md)"))).toBe(
    "loading",
  );

  // The file listing is enough. The index is not required.
  const listed = clientWith({
    files,
    knownFilesLoaded: true,
    pageListSource: "listing",
    fullIndexCompleted: false,
  });
  expect(widgetRenderMode(listed, plain)).toBe("ready");
  expect(inlineEmbedRenderMode(listed, plain, embed("![[Hello]]"))).toBe(
    "ready",
  );
  expect(inlineEmbedRenderMode(listed, plain, embed("![](Hello.md)"))).toBe(
    "ready",
  );

  // Scripts still gate a page transclusion. A resolved document does not wait.
  const noScripts = clientWith({
    files,
    knownFilesLoaded: true,
    pageListSource: "index",
    fullIndexCompleted: true,
    scriptsLoaded: false,
  });
  expect(inlineEmbedRenderMode(noScripts, plain, embed("![[Hello]]"))).toBe(
    widgetRenderMode(noScripts, plain),
  );
  expect(inlineEmbedRenderMode(noScripts, plain, embed("![x](pic.png)"))).toBe(
    "ready",
  );
});

test("opting out of widgets still hides document embeds", () => {
  const optedOut = page(
    "---\npageDecoration:\n  renderWidgets: false\n---\n![[photo.png]]",
  );
  const client = cold({ files: filesWith("Assets/photo.png") });
  expect(inlineEmbedRenderMode(client, optedOut, embed("![[photo.png]]"))).toBe(
    "disabled",
  );
  expect(
    inlineEmbedRenderMode(
      clientWith({
        renderWidgets: false,
        files: filesWith("Assets/photo.png"),
      }),
      plain,
      embed("![[photo.png]]"),
    ),
  ).toBe("disabled");
});
