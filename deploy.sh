#!/bin/sh
yarn run clean && yarn run config && yarn run codegen && yarn run build && yarn run deploy
