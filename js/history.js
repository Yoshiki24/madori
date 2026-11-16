// 取り消し・やり直し(純粋)。状態そのものを積む。
export function createHistory(limit = 50) {
  let undoStack = [];
  let redoStack = [];
  return {
    // 変更の直前の状態を積む。やり直しの履歴は消える
    push(state) {
      undoStack.push(state);
      if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
      redoStack = [];
    },
    undo(current) {
      if (!undoStack.length) return null;
      redoStack.push(current);
      return undoStack.pop();
    },
    redo(current) {
      if (!redoStack.length) return null;
      undoStack.push(current);
      return redoStack.pop();
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    clear() { undoStack = []; redoStack = []; },
    // 履歴に残っている状態(取り消し・やり直しの両方)
    states() { return [...undoStack, ...redoStack]; },
  };
}
