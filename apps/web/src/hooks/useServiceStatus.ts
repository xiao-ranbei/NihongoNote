import { useCallback, useEffect, useRef, useState } from "react";

import type { HealthResponse, LlmBalance } from "@nihongonote/core";

import { getHealth, getLlmBalance } from "../api/client";

/**
 * 本机服务状态（M1.1 从 App.tsx 拆出的第 3 个 hook）。
 *
 * 职责：健康探活（决定顶栏「已连接 / 未连接」）与 LLM 余额查询。
 *
 * 两者的失败语义不同，别混：
 * - 健康检查失败是**真问题**（本机 API 没起来），要经 onError 弹错误横幅；
 * - 余额查询是**附加信息**，未配置 provider 或查询失败都静默降级为 null（UI 显示「余额未知」），
 *   不阻塞页面也不报错。
 */
export interface ServiceStatusController {
  health: HealthResponse | null;
  /** 首次健康检查是否仍在进行（用于「正在连接…」文案）。 */
  isLoading: boolean;
  llmBalance: LlmBalance | null;
  /** 设置页保存后调用：provider 可能变了，余额要重新取。 */
  refreshBalance: () => void;
}

export interface UseServiceStatusOptions {
  /** 错误上报；传 null 表示清空旧横幅（横幅由 App 统一渲染）。 */
  onError: (message: string | null) => void;
}

export function useServiceStatus({ onError }: UseServiceStatusOptions): ServiceStatusController {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [llmBalance, setLlmBalance] = useState<LlmBalance | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    void getHealth()
      .then((healthResponse) => {
        setHealth(healthResponse);
      })
      .catch((reason: unknown) => {
        onErrorRef.current(reason instanceof Error ? reason.message : "无法连接到本机 API");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const refreshBalance = useCallback((): void => {
    void getLlmBalance()
      .then((balance) => {
        setLlmBalance(balance);
      })
      .catch(() => {
        setLlmBalance(null);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getLlmBalance()
      .then((balance) => {
        if (!cancelled) {
          setLlmBalance(balance);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLlmBalance(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { health, isLoading, llmBalance, refreshBalance };
}
