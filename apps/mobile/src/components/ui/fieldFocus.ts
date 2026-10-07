import { createContext } from "react";

// How a TextField tells the scroll container around it that it gained or lost
// focus, so the container can keep the field (and the controls right below it)
// above the keyboard. Null outside such a container: the field works the same,
// it just isn't scrolled into view.
export type FieldFocusListener = {
  onFieldFocus: () => void;
  onFieldBlur: () => void;
};

export const FieldFocusContext = createContext<FieldFocusListener | null>(null);
