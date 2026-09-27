"use client";

import { ReactNode, useEffect, useRef } from "react";

export const VK_WAVE_COLORS = [
  "#520978",
  "#8A83D1",
  "#310F53",
  "#FC3777",
  "#FF0053",
] as const;

type WavyBackgroundProps = {
  children?: ReactNode;
  className?: string;
  containerClassName?: string;
  colors?: readonly string[];
  waveWidth?: number;
  backgroundFill?: string;
  blur?: number;
  speed?: "slow" | "fast";
  waveOpacity?: number;
};

function waveShape(x: number, layer: number, time: number) {
  return (
    Math.sin(x / 190 + layer * 0.88 + time * 1.05) * 0.34 +
    Math.sin(x / 430 - time * 0.68 + layer * 1.6) * 0.38 +
    Math.sin(x / 82 + time * 0.42 + layer * 0.45) * 0.12
  );
}

export function WavyBackground({
  children,
  className,
  containerClassName,
  colors = VK_WAVE_COLORS,
  waveWidth = 44,
  backgroundFill = "#1C1D22",
  blur = 12,
  speed = "slow",
  waveOpacity = 0.3,
}: WavyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let reducedMotion = reducedMotionQuery.matches;
    let animationFrame = 0;
    let time = 0;
    let width = 1;
    let height = 1;
    let pixelRatio = 1;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(bounds.width));
      height = Math.max(1, Math.round(bounds.height));
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      draw();
    };

    const draw = () => {
      context.save();
      context.clearRect(0, 0, width, height);
      context.filter = `blur(${blur}px)`;
      context.fillStyle = backgroundFill;
      context.globalAlpha = 1;
      context.fillRect(0, 0, width, height);
      context.globalAlpha = waveOpacity;
      context.lineWidth = waveWidth;
      context.lineCap = "round";
      context.lineJoin = "round";

      colors.forEach((color, layer) => {
        context.beginPath();
        context.strokeStyle = color;
        const baseline = height * (0.46 + layer * 0.018);
        const amplitude = Math.min(118, Math.max(72, height * 0.2));
        for (let x = -waveWidth; x <= width + waveWidth; x += 6) {
          const y = baseline + waveShape(x, layer, time) * amplitude;
          if (x === -waveWidth) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
        context.closePath();
      });
      context.restore();
    };

    const render = () => {
      draw();
      if (!reducedMotion) {
        time += speed === "fast" ? 0.012 : 0.006;
        animationFrame = window.requestAnimationFrame(render);
      }
    };

    const handleMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) {
        window.cancelAnimationFrame(animationFrame);
        draw();
      } else {
        window.cancelAnimationFrame(animationFrame);
        render();
      }
    };

    resize();
    window.addEventListener("resize", resize);
    reducedMotionQuery.addEventListener("change", handleMotionChange);
    if (!reducedMotion) render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      reducedMotionQuery.removeEventListener("change", handleMotionChange);
    };
  }, [backgroundFill, blur, colors, speed, waveOpacity, waveWidth]);

  return (
    <div
      className={`wavy-background${containerClassName ? ` ${containerClassName}` : ""}`}
      aria-hidden={children ? undefined : true}
    >
      <canvas ref={canvasRef} className="wavy-background-canvas" />
      {children && (
        <div
          className={`wavy-background-content${className ? ` ${className}` : ""}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
