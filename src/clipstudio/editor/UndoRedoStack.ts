/**
 * UndoRedoStack.ts
 * Manages non-destructive undo and redo history for an audio clip tab.
 * Since AudioPieceTable is immutable/lightweight, each undo state stores
 * piece descriptors with O(1) memory per step.
 */

import { AudioPieceTable } from './AudioPieceTable.ts';

export interface UndoSnapshot {
  table: AudioPieceTable;
  selectionStartSample: number;
  selectionEndSample: number;
  playheadSample: number;
  description: string;
  timestamp: number;
}

export class UndoRedoStack {
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth: number = 50) {
    this.maxDepth = maxDepth;
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public get undoCount(): number {
    return this.undoStack.length;
  }

  public get redoCount(): number {
    return this.redoStack.length;
  }

  public get currentUndoDescription(): string | null {
    if (this.undoStack.length === 0) return null;
    return this.undoStack[this.undoStack.length - 1].description;
  }

  public get currentRedoDescription(): string | null {
    if (this.redoStack.length === 0) return null;
    return this.redoStack[this.redoStack.length - 1].description;
  }

  /**
   * Push a state before making a mutation.
   * Clears redo stack.
   */
  public push(snapshot: UndoSnapshot): void {
    this.undoStack.push({
      table: snapshot.table.clone(),
      selectionStartSample: snapshot.selectionStartSample,
      selectionEndSample: snapshot.selectionEndSample,
      playheadSample: snapshot.playheadSample,
      description: snapshot.description,
      timestamp: snapshot.timestamp || Date.now()
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }

    // New action invalidates redo history
    this.redoStack = [];
  }

  /**
   * Undo to the previous state.
   * Takes the current state to push onto the redo stack.
   */
  public undo(currentState: UndoSnapshot): UndoSnapshot | null {
    if (this.undoStack.length === 0) return null;

    const previous = this.undoStack.pop()!;
    this.redoStack.push({
      table: currentState.table.clone(),
      selectionStartSample: currentState.selectionStartSample,
      selectionEndSample: currentState.selectionEndSample,
      playheadSample: currentState.playheadSample,
      description: currentState.description,
      timestamp: Date.now()
    });

    return previous;
  }

  /**
   * Redo to the next forward state.
   * Takes the current state to push onto the undo stack.
   */
  public redo(currentState: UndoSnapshot): UndoSnapshot | null {
    if (this.redoStack.length === 0) return null;

    const next = this.redoStack.pop()!;
    this.undoStack.push({
      table: currentState.table.clone(),
      selectionStartSample: currentState.selectionStartSample,
      selectionEndSample: currentState.selectionEndSample,
      playheadSample: currentState.playheadSample,
      description: currentState.description,
      timestamp: Date.now()
    });

    return next;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
