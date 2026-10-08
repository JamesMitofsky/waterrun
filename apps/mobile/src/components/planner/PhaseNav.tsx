import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CaretLeftIcon } from "phosphor-react-native/src/icons/CaretLeft";
import { CaretRightIcon } from "phosphor-react-native/src/icons/CaretRight";

type NavAction = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
};

// The text buttons draw ~36pt tall; the slop takes their targets to 44pt
// without changing the look (nothing interactive sits close enough to overlap).
const NAV_HIT_SLOP = { top: 4, bottom: 4, left: 8, right: 8 };

// Shared prev/next chrome so the planner's stacked views — setup → build → run —
// page through in order. Forward carries that view's transition (and its gating);
// back just steps to the prior view. A missing side (first/last view) leaves an
// empty slot so the present control keeps its edge.
export function PhaseNav({ back, forward }: { back?: NavAction; forward?: NavAction }) {
  return (
    <View className="flex-row items-center justify-between pt-3">
      {back ? (
        <Pressable
          onPress={back.onPress}
          disabled={back.disabled || back.loading}
          accessibilityRole="button"
          hitSlop={NAV_HIT_SLOP}
          className={`flex-row items-center gap-1 rounded-xl px-2 py-2 ${
            back.disabled || back.loading ? "opacity-40" : ""
          }`}
        >
          <CaretLeftIcon size={16} color="#57544a" />
          <Text className="text-muted text-sm font-semibold">{back.label}</Text>
        </Pressable>
      ) : (
        <View />
      )}
      {forward ? (
        <Pressable
          onPress={forward.onPress}
          disabled={forward.disabled || forward.loading}
          accessibilityRole="button"
          hitSlop={NAV_HIT_SLOP}
          className={`flex-row items-center gap-1 rounded-xl px-2 py-2 ${
            forward.disabled || forward.loading ? "opacity-40" : ""
          }`}
        >
          {forward.loading ? <ActivityIndicator size="small" color="#4fafd4" /> : null}
          <Text className="text-link text-sm font-bold">{forward.label}</Text>
          <CaretRightIcon size={16} color="#4fafd4" />
        </Pressable>
      ) : (
        <View />
      )}
    </View>
  );
}
