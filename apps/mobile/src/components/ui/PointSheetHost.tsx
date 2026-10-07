import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet, RNHostView } from "@expo/ui";
import { FieldFocusContext, type FieldFocusListener } from "./fieldFocus";

// Height the native sheet keeps for itself above our content: on iOS the gap a
// full-height sheet leaves under the status bar plus @expo/ui's 16pt top
// padding, on Android M3's 48dp drag handle. Rounded up on purpose: a spare
// point only makes the content scroll a little sooner, a missing one clips it.
const SHEET_CHROME = Platform.OS === "ios" ? 44 : 56;

// Floor for the scroll area, so an odd metrics reading can't collapse the sheet.
const MIN_SCROLL_HEIGHT = 160;

// Height of the software keyboard over the bottom of the screen; 0 when down.
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS === "ios") {
      // iOS posts keyboard notifications app-wide, so this reaches us even
      // though the field sits in a separately presented sheet, and "will"
      // arrives in time to resize alongside the keyboard. The keyboard runs to
      // the screen edge, so measure it from the bottom of the window.
      const sub = Keyboard.addListener("keyboardWillChangeFrame", (e) =>
        setHeight(Math.max(0, Dimensions.get("window").height - e.endCoordinates.screenY)),
      );
      return () => sub.remove();
    }
    // Android has no "will" events, and RN derives these from the activity
    // window's insets while the sheet's field belongs to the sheet's own dialog
    // window, so they may never arrive. The height then stays 0: content can
    // sit under the keyboard until Done or Back closes it, and is all
    // reachable after. A guessed height would cut the sheet short instead.
    const subs = [
      Keyboard.addListener("keyboardDidShow", (e) => setHeight(e.endCoordinates.height)),
      Keyboard.addListener("keyboardDidHide", () => setHeight(0)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return height;
}

type Props = {
  isPresented: boolean;
  onDismiss: () => void;
  children: ReactNode;
};

// Native OS bottom sheet (SwiftUI / Jetpack Compose via @expo/ui) for a tapped
// point; the content stays plain RN, bridged in through RNHostView. With no
// snapPoints the sheet hugs its content (iOS fitToContents, Android intrinsic
// height) instead of opening to a fixed, over-tall detent.
//
// The hosted RN view is pinned to its own Yoga size on both platforms, so the
// sheet can't shrink it: whatever doesn't fit (a tall form, or any form once
// the keyboard is up) used to be clipped off the bottom, taking the action row
// with it. So the content scrolls inside a box capped at the height the sheet
// can actually show, which already leaves out the keyboard; the sheet then
// hugs that box. KeyboardAvoidingView can't do this: it measures its frame
// relative to the hosted root, not the screen.
export function PointSheetHost({ isPresented, onDismiss, children }: Props) {
  // matchContents sizes the host to its child's *intrinsic* size and ignores
  // an explicit width on the host itself. So the explicit width goes on the
  // child: full window minus the sheet's 16px L/R padding (a percentage width
  // doesn't resolve inside the native host), and matchContents wraps to it.
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  // iOS's keyboard covers the home-indicator inset; Android's reported height
  // stops at the navigation bar (RN subtracts it), so the two stack.
  const bottom = Platform.OS === "ios" ? Math.max(kb, insets.bottom) : insets.bottom + kb;
  const maxHeight = Math.max(MIN_SCROLL_HEIGHT, winH - insets.top - bottom - SHEET_CHROME);

  const scrollRef = useRef<ScrollView>(null);
  const fieldFocused = useRef(false);
  // While a field has focus, keep the end of the sheet (the field's tail and
  // the action row below it) in view as the box shrinks for the keyboard or
  // the field grows a line. A drag hands control back to the user until they
  // return to the bottom themselves.
  const followEnd = useRef(false);
  const keepEndInView = () => {
    if (followEnd.current) scrollRef.current?.scrollToEnd();
  };
  const resumeFollowAtEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    followEnd.current =
      fieldFocused.current && contentOffset.y + layoutMeasurement.height >= contentSize.height - 1;
  };
  const fieldFocus = useMemo<FieldFocusListener>(
    () => ({
      onFieldFocus: () => {
        fieldFocused.current = true;
        followEnd.current = true;
        scrollRef.current?.scrollToEnd();
      },
      onFieldBlur: () => {
        fieldFocused.current = false;
        followEnd.current = false;
      },
    }),
    [],
  );

  return (
    <BottomSheet
      isPresented={isPresented}
      onDismiss={() => {
        Keyboard.dismiss();
        onDismiss();
      }}
    >
      <RNHostView matchContents>
        <View style={{ width: winW - 32 }}>
          <ScrollView
            ref={scrollRef}
            style={{ maxHeight }}
            // A tap on a control works first time with the keyboard up; a tap
            // on blank space lands on the Pressable below and closes it.
            keyboardShouldPersistTaps="handled"
            // Android has no interactive mode; there any drag closes it.
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            alwaysBounceVertical={false}
            // Android: offer drags to the Compose sheet first (RNHostView relays
            // nested scroll), so a half-open sheet expands before content scrolls.
            nestedScrollEnabled
            onLayout={keepEndInView}
            onContentSizeChange={keepEndInView}
            onScrollBeginDrag={() => {
              followEnd.current = false;
            }}
            onScrollEndDrag={resumeFollowAtEnd}
            onMomentumScrollEnd={resumeFollowAtEnd}
          >
            {/* The ScrollView's own blank-tap dismissal needs a keyboard event
                Android may never deliver here (see useKeyboardHeight), so a
                plain press handler does it on both platforms. */}
            <Pressable accessible={false} onPress={() => Keyboard.dismiss()}>
              <FieldFocusContext value={fieldFocus}>{children}</FieldFocusContext>
            </Pressable>
          </ScrollView>
        </View>
      </RNHostView>
    </BottomSheet>
  );
}
