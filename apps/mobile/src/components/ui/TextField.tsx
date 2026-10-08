import { useContext, type Ref } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { stripLineBreaks } from "@rosm/core/note";
import { FieldFocusContext } from "./fieldFocus";

// Return's behavior is fixed below, so it isn't a prop (blurOnSubmit is the
// deprecated spelling of the same thing).
type Props = Omit<TextInputProps, "submitBehavior" | "blurOnSubmit"> & {
  ref?: Ref<TextInput>;
};

// The app's only text input (eslint.config.js bans importing TextInput
// anywhere else). iOS shows no Done bar over a text keyboard, and a multiline
// RN TextInput's Return just inserts a newline, so once a field had focus
// nothing on screen could close the keyboard, and the keyboard could sit over
// the very button the user needed next. Here Return is always "Done": it blurs
// the field, which closes the keyboard on both platforms, and still fires
// onSubmitEditing. `multiline` keeps working for wrapping; with Return taken,
// line breaks can only arrive by paste, so they're flattened as they come in.
export function TextField({
  onChangeText,
  onFocus,
  onBlur,
  returnKeyType = "done",
  ...rest
}: Props) {
  const focusListener = useContext(FieldFocusContext);
  return (
    <TextInput
      returnKeyType={returnKeyType}
      {...rest}
      submitBehavior="blurAndSubmit"
      onChangeText={onChangeText ? (text) => onChangeText(stripLineBreaks(text)) : undefined}
      onFocus={(e) => {
        focusListener?.onFieldFocus();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusListener?.onFieldBlur();
        onBlur?.(e);
      }}
    />
  );
}
