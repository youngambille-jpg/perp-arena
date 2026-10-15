// Public metadata used to render Perpl account creation and funding flows.

import { Router, type Request, type Response } from 'express';
import { PERPL_CHAIN_ID } from '../../config.js';
import { ApiError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { fetchContext } from '../../perpl/rest.js';
import { asyncRoute } from '../middleware.js';

export const metaRouter = Router();

metaRouter.get(
  '/account-creation',
  asyncRoute(async (_req: Request, res: Response) => {
    let context;
    try {
      context = await fetchContext();
    } catch (error) {
      logger.error('account creation metadata fetch failed', error);
      throw new ApiError(
        502,
        'account_metadata_unavailable',
        'Unable to fetch Perpl account creation metadata',
      );
    }

    const instance = context.instances[0];
    const token = context.tokens.find(
      (candidate) => candidate.id === instance?.collateral_token_id,
    );
    if (
      !instance ||
      !token ||
      !instance.address ||
      !token.address ||
      !token.symbol ||
      !Number.isInteger(token.decimals) ||
      (token.decimals as number) < 0
    ) {
      throw new ApiError(
        502,
        'account_metadata_invalid',
        'Perpl account creation metadata is incomplete',
      );
    }

    const amount = (raw: string | number | undefined, name: string) => {
      if (raw === undefined || !/^\d+$/.test(String(raw))) {
        throw new ApiError(
          502,
          'account_metadata_invalid',
          `Perpl ${name} metadata is missing or invalid`,
        );
      }
      const rawAmount = String(raw);
      const value = Number(rawAmount) / 10 ** token.decimals!;
      if (!Number.isFinite(value)) {
        throw new ApiError(
          502,
          'account_metadata_invalid',
          `Perpl ${name} metadata is invalid`,
        );
      }
      return { raw: rawAmount, amount: value };
    };

    res.json({
      chainId: context.chain.chain_id ?? context.chain.id ?? PERPL_CHAIN_ID,
      network: context.chain.name ?? null,
      exchangeAddress: instance.address,
      collateralToken: {
        id: token.id,
        address: token.address,
        symbol: token.symbol,
        name: token.name ?? token.symbol,
        decimals: token.decimals,
      },
      minAccountOpenAmount: amount(
        instance.min_account_open_amount,
        'minimum account-open amount',
      ),
      minDepositAmount: amount(
        instance.min_deposit_amount,
        'minimum deposit amount',
      ),
    });
  }),
);
