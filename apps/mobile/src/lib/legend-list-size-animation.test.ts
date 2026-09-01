import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as TypeScript from "typescript";
import { describe, expect, it } from "vite-plus/test";

import { createReactHookHarness } from "../../../web/src/test/reactHookHarness";

const bundles = ["reanimated.js", "reanimated.mjs"].map((name) => {
  const path = new URL(`../../node_modules/@legendapp/list/${name}`, import.meta.url);
  const source = NodeFS.readFileSync(path, "utf8");
  return {
    name,
    source: name.endsWith(".mjs")
      ? TypeScript.transpileModule(source, {
          compilerOptions: {
            module: TypeScript.ModuleKind.CommonJS,
            target: TypeScript.ScriptTarget.ESNext,
            esModuleInterop: true,
          },
        }).outputText
      : source,
  };
});

type SizeSignal = "totalSize" | "alignItemsAtEndPadding";
type NativeStyle = { readonly height?: number; readonly width?: number };
type AnimatedStyle = { read: () => NativeStyle };
type Style = NativeStyle | AnimatedStyle | ReadonlyArray<Style> | undefined;
type Animation = {
  readonly target: number;
  readonly complete: (finished: boolean) => void;
};

class AnimatedNumber {
  private current: number;
  private animation: (Animation & { readonly from: number }) | null = null;

  constructor(initial: number) {
    this.current = initial;
  }

  get value(): number {
    return this.current;
  }

  set value(next: number | Animation) {
    const previous = this.animation;
    this.animation = null;
    previous?.complete(false);
    if (typeof next === "number") {
      this.current = next;
    } else {
      this.animation = { ...next, from: this.current };
    }
  }

  advance(progress: number) {
    const animation = this.animation;
    if (animation === null) {
      return;
    }
    this.current = animation.from + (animation.target - animation.from) * progress;
    if (progress === 1) {
      this.animation = null;
      animation.complete(true);
    }
  }
}

function makeSizeView(bundleSource: string, signalName: SizeSignal, initialSize: number) {
  const hooks = createReactHookHarness();
  const values: Array<AnimatedNumber> = [];
  const effects: Array<() => void> = [];
  const attachedStyles = new Set<AnimatedStyle>();
  const animatedNativeProps: { height?: number; width?: number } = {};
  let staticNativeProps: NativeStyle = {};
  let renderPending = false;
  const signals = { totalSize: initialSize, alignItemsAtEndPadding: initialSize };
  const ctx = {
    state: {
      contentSizeAnimationEpoch: 0,
      contentSizeAnimationEligible: false,
      contentSizeAnimationActiveEpoch: undefined as number | undefined,
      contentSizeAnimationActiveSignals: new Set<string>(),
    },
  };

  const react = {
    useRef: hooks.useRef,
    useCallback: hooks.useCallback,
    useState<T>(initial: T) {
      const [value, setValue] = hooks.useState(initial);
      return [
        value,
        (next: T) => {
          setValue(next);
          renderPending = true;
        },
      ];
    },
    useLayoutEffect(effect: () => void, dependencies: ReadonlyArray<unknown>) {
      const previous = hooks.useRef<ReadonlyArray<unknown> | undefined>(undefined);
      if (
        previous.current === undefined ||
        dependencies.some((dependency, index) => !Object.is(dependency, previous.current?.[index]))
      ) {
        previous.current = dependencies;
        effects.push(effect);
      }
    },
    forwardRef: (component: unknown) => component,
    createElement: (_component: unknown, props: { readonly style: Style }) => ({ props }),
  };

  const publishAnimatedStyles = () => {
    for (const style of attachedStyles) {
      Object.assign(animatedNativeProps, style.read());
    }
  };
  const reanimated = {
    View: "AnimatedView",
    createAnimatedComponent: (component: unknown) => component,
    runOnJS: (callback: (...args: unknown[]) => void) => callback,
    runOnUI: (callback: (...args: unknown[]) => void) => callback,
    useSharedValue(initial: number) {
      const reference = hooks.useRef<AnimatedNumber | null>(null);
      if (reference.current === null) {
        reference.current = new AnimatedNumber(initial);
        values.push(reference.current);
      }
      return reference.current;
    },
    useAnimatedStyle(read: () => NativeStyle) {
      const reference = hooks.useRef<AnimatedStyle>({ read });
      reference.current.read = read;
      return reference.current;
    },
  };
  const modules: Record<string, unknown> = {
    react,
    "react-native": { View: "View" },
    "react-native-reanimated": reanimated,
    "@legendapp/list/react-native": {
      internal: {
        typedMemo: (component: unknown) => component,
        useStateContext: () => ctx,
        useArr$: (names: ReadonlyArray<SizeSignal>) => names.map((name) => signals[name]),
      },
    },
  };
  const module = { exports: {} };
  // Execute the installed patch, not a copy of its size/animation logic.
  NodeVM.runInNewContext(`${bundleSource}\nmodule.exports = ReanimatedSizeView;`, {
    module,
    exports: module.exports,
    require(name: string) {
      if (!(name in modules)) {
        throw new Error(`Unexpected LegendList dependency: ${name}`);
      }
      return modules[name];
    },
  });
  const SizeView = module.exports as (props: {
    readonly signalName: SizeSignal;
    readonly horizontal: false;
    readonly layoutTransition: typeof transition;
  }) => { readonly props: { readonly style: Style } };
  const transition = {
    getAnimationAndConfig: () => [
      (target: number, _config: unknown, complete: Animation["complete"]): Animation => ({
        target,
        complete,
      }),
      {},
    ],
  };

  function commitStyle(style: Style) {
    if (Array.isArray(style)) {
      style.forEach(commitStyle);
    } else if (style && "read" in style) {
      attachedStyles.add(style);
    } else if (style) {
      staticNativeProps = { ...staticNativeProps, ...style };
    }
  }

  function render() {
    let passes = 0;
    do {
      if (++passes > 10) {
        throw new Error("Size view did not finish rendering.");
      }
      renderPending = false;
      hooks.beginRender();
      const element = SizeView({ signalName, horizontal: false, layoutTransition: transition });
      // Reanimated 4's ViewDescriptorsSet.remove detaches future updates but
      // leaves native animated props intact. Its Fabric commit hook reapplies
      // that registry over React's static props on subsequent commits.
      attachedStyles.clear();
      staticNativeProps = {};
      commitStyle(element.props.style);
      for (const effect of effects.splice(0)) {
        effect();
      }
      publishAnimatedStyles();
    } while (renderPending);
  }

  render();
  return {
    update(size: number, eligible: boolean, newEpoch = true) {
      signals[signalName] = size;
      ctx.state.contentSizeAnimationEligible = eligible;
      if (newEpoch) {
        ctx.state.contentSizeAnimationEpoch += 1;
      }
      render();
    },
    advance(progress: number) {
      for (const value of values) {
        value.advance(progress);
      }
      publishAnimatedStyles();
      if (renderPending) {
        render();
      }
    },
    nativeSize: () => animatedNativeProps.height ?? staticNativeProps.height ?? 0,
    dragAfterJumpToEnd() {
      const otherContentHeight = 1_000;
      const viewportHeight = 600;
      // scrollToOverflowEnabled lets the arrow reach LegendList's logical
      // target. A gesture must then obey the actual UIScrollView content size.
      const target = signals[signalName] + otherContentHeight - viewportHeight;
      const nativeEnd =
        (animatedNativeProps.height ?? staticNativeProps.height ?? 0) +
        otherContentHeight -
        viewportHeight;
      return Math.min(target + 100, nativeEnd);
    },
  };
}

describe.each(bundles)("LegendList $name", ({ source }) => {
  describe.each<SizeSignal>(["totalSize", "alignItemsAtEndPadding"])(
    "animated %s",
    (signalName) => {
      it("keeps the native scroll range current after a disclosure animation finishes", () => {
        const view = makeSizeView(source, signalName, 1_200);
        view.update(1_600, true);
        view.advance(1);
        expect(view.nativeSize()).toBe(1_600);

        view.update(2_400, false);
        expect(view.dragAfterJumpToEnd()).toBe(2_800);
        expect(view.nativeSize()).toBe(2_400);

        view.update(800, false);
        expect(view.nativeSize()).toBe(800);
      });

      it("preserves measurement corrections across overlapping animations and later updates", () => {
        const view = makeSizeView(source, signalName, 1_200);
        view.update(1_600, true);
        view.advance(0.5);
        expect(view.nativeSize()).toBe(1_400);

        // A same-epoch measurement moves the base without restarting the tween.
        view.update(1_700, false, false);
        expect(view.nativeSize()).toBe(1_500);
        view.update(2_000, true);
        expect(view.nativeSize()).toBe(1_500);
        view.advance(0.5);
        expect(view.nativeSize()).toBe(1_750);
        view.advance(1);
        expect(view.nativeSize()).toBe(2_000);

        view.update(2_600, false);
        expect(view.nativeSize()).toBe(2_600);
        expect(view.dragAfterJumpToEnd()).toBe(3_000);
      });
    },
  );
});
