import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, ReactNode } from 'react';

// Press-and-hold (180 ms) to pick up on touch so normal scrolling still works.
export function SortableList<T extends { key: string }>({ items, onReorder, horizontal, children }: {
  items: T[]; onReorder: (next: T[]) => void; horizontal?: boolean; children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.key === active.id);
    const to = items.findIndex((i) => i.key === over.id);
    onReorder(arrayMove(items, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((i) => i.key)} strategy={horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function SortableItem({ id, children, style, className }: { id: string; children: ReactNode; style?: CSSProperties; className?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} className={className} {...attributes} {...listeners}
      style={{
        ...style,
        transform: CSS.Translate.toString(transform), transition,
        zIndex: isDragging ? 5 : undefined, position: 'relative',
        scale: isDragging ? '1.03' : undefined, boxShadow: isDragging ? 'var(--shadow-lg)' : undefined,
        touchAction: 'manipulation',
      }}>
      {children}
    </div>
  );
}
