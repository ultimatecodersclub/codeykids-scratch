import { folderOf } from "./files";

// The site's files as folders and files, folders first, each level sorted.
// Empty folders the kid made are shown too, until something goes in them.
type Node = { children: Node[]; folder: boolean; name: string; path: string };

const treeOf = (paths: string[], emptyFolders: string[]) => {
  const root: Node = { children: [], folder: true, name: "", path: "" };
  const folders = new Map<string, Node>([["", root]]);

  const folderNode = (path: string): Node => {
    const known = folders.get(path);

    if (known) return known;

    const node: Node = { children: [], folder: true, name: path.slice(path.lastIndexOf("/") + 1), path };

    folders.set(path, node);
    folderNode(folderOf(path)).children.push(node);

    return node;
  };

  for (const folder of emptyFolders) folderNode(folder);
  for (const path of paths) {
    folderNode(folderOf(path)).children.push({
      children: [],
      folder: false,
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
    });
  }

  const sort = (node: Node) => {
    node.children.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
    node.children.forEach(sort);
  };

  sort(root);

  return root;
};

type Props = {
  active: string;
  // The folder new and uploaded files go into.
  current: string;
  emptyFolders: string[];
  onDelete: (path: string, folder: boolean) => void;
  onOpen: (path: string) => void;
  onPickFolder: (path: string) => void;
  onRename: (path: string, folder: boolean) => void;
  paths: string[];
  readOnly: boolean;
};

export const FileTree = ({
  active,
  current,
  emptyFolders,
  onDelete,
  onOpen,
  onPickFolder,
  onRename,
  paths,
  readOnly,
}: Props) => {
  const rows = (node: Node, depth: number): JSX.Element[] =>
    node.children.flatMap((child) => {
      const selected = child.folder ? child.path === current : child.path === active;
      const row = (
        <li
          className={child.folder ? `folder${selected ? " current" : ""}` : selected ? "active" : ""}
          key={`${child.folder ? "d" : "f"}:${child.path}`}
        >
          <button
            className="file-name"
            onClick={() => (child.folder ? onPickFolder(child.path) : onOpen(child.path))}
            style={{ paddingLeft: 10 + depth * 14 }}
            title={child.folder ? `${child.path}/ (new files go here)` : child.path}
            type="button"
          >
            {child.folder ? `📁 ${child.name}` : child.name}
            {child.folder && child.children.length === 0 && <span className="empty"> (empty)</span>}
          </button>
          {!readOnly && (
            <span className="file-actions">
              <button onClick={() => onRename(child.path, child.folder)} title={child.folder ? "Rename folder" : "Rename or move"} type="button">
                ✎
              </button>
              <button onClick={() => onDelete(child.path, child.folder)} title={child.folder ? "Delete folder" : "Delete"} type="button">
                ×
              </button>
            </span>
          )}
        </li>
      );

      return child.folder ? [row, ...rows(child, depth + 1)] : [row];
    });

  return (
    <ul>
      {/* The top of the site, so files can go back there. */}
      <li className={current === "" ? "folder current" : "folder"} key="d:">
        <button className="file-name" onClick={() => onPickFolder("")} title="The top of your site (new files go here)" type="button">
          📁 your site
        </button>
      </li>
      {rows(treeOf(paths, emptyFolders), 1)}
    </ul>
  );
};
