import { presentationDocumentSchema, type PresentationDocument } from "./schemas";

const DRAFT_KEY = "vk-tech-hackathon-presentation-v1";
const DATABASE_NAME = "vk-tech-hackathon-drafts";
const STORE_NAME = "drafts";
const DATABASE_VERSION = 1;

export type DraftStorageMode = "indexeddb" | "localStorage" | "memory";

let operationQueue: Promise<unknown> = Promise.resolve();

export async function loadPresentationDraft(): Promise<PresentationDocument | null> {
  if (!hasWindow()) return null;

  if (hasIndexedDb()) {
    try {
      const draft = await readFromIndexedDb();
      if (draft) return draft;
    } catch {
      // Fall back to the legacy localStorage draft when IndexedDB is unavailable.
    }
  }

  try {
    const saved = window.localStorage.getItem(DRAFT_KEY);
    return saved ? validatedDraft(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

export function savePresentationDraft(document: PresentationDocument): Promise<DraftStorageMode> {
  return enqueue(async () => {
    if (!hasWindow()) return "memory";

    if (hasIndexedDb()) {
      try {
        await writeToIndexedDb(document);
        try {
          window.localStorage.removeItem(DRAFT_KEY);
        } catch {
          // A stale localStorage value must not make a successful IndexedDB save fail.
        }
        return "indexeddb";
      } catch {
        // Fall through to the legacy store or in-memory mode.
      }
    }

    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(document));
      return "localStorage";
    } catch {
      // The editor remains usable even when both browser stores are unavailable.
      return "memory";
    }
  });
}

export function clearPresentationDraft(): Promise<void> {
  return enqueue(async () => {
    if (!hasWindow()) return;

    if (hasIndexedDb()) {
      try {
        await deleteFromIndexedDb();
      } catch {
        // Continue clearing the legacy store even when IndexedDB is unavailable.
      }
    }

    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Private browsing or a disabled storage area should not block a new project.
    }
  });
}

function hasWindow() {
  return typeof window !== "undefined";
}

function hasIndexedDb() {
  return hasWindow() && "indexedDB" in window;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

async function readFromIndexedDb(): Promise<PresentationDocument | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(DRAFT_KEY);
      request.onsuccess = () => resolve(validatedDraft(request.result));
      request.onerror = () => reject(request.error || new Error("IndexedDB draft read failed"));
    });
  } finally {
    database.close();
  }
}

function validatedDraft(value: unknown): PresentationDocument | null {
  const parsed = presentationDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function writeToIndexedDb(document: PresentationDocument): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(document, DRAFT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB draft write failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB draft write aborted"));
    });
  } finally {
    database.close();
  }
}

async function deleteFromIndexedDb(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(DRAFT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB draft delete failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB draft delete aborted"));
    });
  } finally {
    database.close();
  }
}
