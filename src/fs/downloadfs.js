// ─── DownloadFS: /pc/ — bridge between virtual FS and real machine ─
//
// Write to /pc/<name> → triggers a browser download of that file
// to the user's real machine.
// Read from /pc/ → opens a file picker to select a local file.
//
// Examples:
//   cp report.csv /pc            → downloads report.csv
//   echo hello > /pc/note.txt    → downloads note.txt
//   cp /pc/photo.jpg .           → file picker → import into virtual FS
// -----------------------------------------------------------------

export class DownloadFS {
  async read(path) {
    const name = path.replace(/^\//, "");
    // Read a file from the user's machine via file picker
    const picker = window.showOpenFilePicker;
    if (!picker) {
      throw new Error("File picker not supported in this browser");
    }
    try {
      const [handle] = await picker();
      const file = await handle.getFile();
      const text = await file.text();
      return text;
    } catch (e) {
      throw new Error(`file picker cancelled: ${e.message}`);
    }
  }

  async write(path, content) {
    const name = path.replace(/^\//, "");
    if (!name) {
      throw new Error("EROFS: specify a filename (/pc/name)");
    }
    const blob = typeof content === "string"
      ? new Blob([content], { type: "text/plain" })
      : new Blob([content]);
    await this._save(name, blob);
  }

  async writeBlob(path, blob) {
    const name = path.replace(/^\//, "");
    if (!name) {
      throw new Error("EROFS: specify a filename (/pc/name)");
    }
    await this._save(name, blob);
  }

  async _save(name, blob) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e) {
        throw new Error(`download cancelled: ${e.message}`);
      }
    }

    // Fallback: trigger a regular browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async list(path) {
    // /pc/ is a bridge, not a directory — nothing to list
    return [];
  }

  async remove(path) {
    throw new Error("EROFS: cannot remove from /pc/");
  }
}
