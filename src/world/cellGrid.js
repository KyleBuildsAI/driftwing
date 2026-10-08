// A sparse 2D grid of item lists, keyed by integer cell indices (x, z), for the spatial hashes of
// the collider service (colliders.js) and the extra ground surfaces (groundSurfaces.js).
//
// The cells live in a Map of column x to a Map of row z, so both keys stay small integers: a single
// packed key would leave the small-integer range, and the JIT then boxes it into a new heap number on
// every lookup. A cell is { items, count }: readers walk items[0 .. count - 1]; the array never
// shrinks (shortening an array can release its storage, and the next push would allocate it again).
// Emptied cells and rows go back to free lists, and a refiling (moving) item keeps its emptied cells,
// so steady-state use allocates nothing.

export function createCellGrid() {
  const columns = new Map();
  const freeCells = [];
  const freeRows = [];
  let cellCount = 0;

  /** Takes item out of a plain array (the grid's oversized lists) without splice's returned array. */
  function removeFrom(list, item) {
    const index = list.indexOf(item);
    if (index < 0) return false;
    for (let move = index; move < list.length - 1; move++) list[move] = list[move + 1];
    list.length--;
    return true;
  }

  return {
    /** The cell (cellX, cellZ) as { items, count }, or undefined when it was never filled. */
    get(cellX, cellZ) {
      const row = columns.get(cellX);
      return row === undefined ? undefined : row.get(cellZ);
    },

    /** Appends item to the cell. */
    add(cellX, cellZ, item) {
      let row = columns.get(cellX);
      if (row === undefined) {
        row = freeRows.length > 0 ? freeRows.pop() : new Map();
        columns.set(cellX, row);
      }
      let cell = row.get(cellZ);
      if (cell === undefined) {
        cell = freeCells.length > 0 ? freeCells.pop() : { items: [], count: 0 };
        row.set(cellZ, cell);
      }
      if (cell.count === 0) cellCount++;
      cell.items[cell.count++] = item;
    },

    /**
     * Removes item from the cell; an emptied cell (and row) is released, unless keepEmpty (a moving
     * item refiling: it will be back, and releasing and re-creating map entries allocates).
     */
    remove(cellX, cellZ, item, keepEmpty = false) {
      const row = columns.get(cellX);
      if (row === undefined) return false;
      const cell = row.get(cellZ);
      if (cell === undefined) return false;
      const items = cell.items;
      let index = -1;
      for (let search = 0; search < cell.count; search++) {
        if (items[search] === item) {
          index = search;
          break;
        }
      }
      if (index < 0) return false;
      for (let move = index; move < cell.count - 1; move++) items[move] = items[move + 1];
      cell.count--;
      items[cell.count] = null;
      if (cell.count > 0) return true;
      cellCount--;
      if (!keepEmpty) {
        row.delete(cellZ);
        freeCells.push(cell);
        if (row.size === 0) {
          columns.delete(cellX);
          freeRows.push(row);
        }
      }
      return true;
    },

    /** The number of cells holding something. */
    get size() {
      return cellCount;
    },

    removeFrom,
  };
}
