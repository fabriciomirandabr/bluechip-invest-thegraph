import { Address, BigDecimal, BigInt, store } from '@graphprotocol/graph-ts'

import { ERC20 } from '../types/Investment/ERC20'
import { ERC721 } from '../types/Investment/ERC721'
import { Acquired, Claim, Join, Leave, Listed, Investment, Payout, Relisted } from '../types/Investment/Investment'
import { Collection, Counter, Currency, Listing, Nft, UserListing } from '../types/schema'

let ZERO_BIGINT = BigInt.fromI32(0)
let ZERO_BIGDECIMAL = ZERO_BIGINT.toBigDecimal()
let ZERO_ADDRESS = Address.fromString('0x0000000000000000000000000000000000000000')

function coins(amount: BigInt, decimals: i32): BigDecimal {
  if (decimals > 0) {
    let scale = BigInt.fromI32(10)
      .pow(decimals as u8)
      .toBigDecimal()
    return amount.toBigDecimal().div(scale)
  }
  if (decimals < 0) {
    let scale = BigInt.fromI32(10)
      .pow(-decimals as u8)
      .toBigDecimal()
    return amount.toBigDecimal().times(scale)
  }
  return amount.toBigDecimal()
}

function registerCurrency(address: Address): Currency {
  let currencyId = address.toHexString()
  let currency = Currency.load(currencyId)
  if (currency == null) {
    currency = new Currency(currencyId)
    currency.decimals = 18
    if (address != ZERO_ADDRESS) {
      let contract = ERC20.bind(address)
      {
        let result = contract.try_name()
        if (!result.reverted) {
          currency.name = result.value
        }
      }
      {
        let result = contract.try_symbol()
        if (!result.reverted) {
          currency.symbol = result.value
        }
      }
      {
        let result = contract.try_decimals()
        if (!result.reverted) {
          currency.decimals = result.value
        }
      }
    }
    currency.save()
  }
  return currency as Currency
}

function registerCollection(address: Address): Collection {
  let collectionId = address.toHexString()
  let collection = Collection.load(collectionId)
  if (collection == null) {
    collection = new Collection(collectionId)
    let contract = ERC721.bind(address)
    {
      let result = contract.try_name()
      if (!result.reverted) {
        collection.name = result.value
      }
    }
    {
      let result = contract.try_symbol()
      if (!result.reverted) {
        collection.symbol = result.value
      }
    }
    collection.save()
  }
  return collection as Collection
}

function registerNft(address: Address, tokenId: BigInt): Nft {
  let nftId = address
    .toHexString()
    .concat('#')
    .concat(tokenId.toString())
  let nft = Nft.load(nftId)
  if (nft == null) {
    let collection = registerCollection(address)

    nft = new Nft(nftId)
    nft.collection = collection.id
    nft.tokenId = tokenId
  }
  let contract = ERC721.bind(address)
  {
    let result = contract.try_tokenURI(tokenId)
    if (!result.reverted) {
      nft.tokenURI = result.value
    }
  }
  nft.save()
  return nft as Nft
}

function registerListing(address: Address, id: BigInt, creator: Address, timestamp: BigInt): Listing | null {
  let listingId = id.toString()
  let listing = Listing.load(listingId)

  let contract = Investment.bind(address)
  let result = contract.listings(id)
  let state = result.value0
  let seller = result.value1
  let target = result.value2
  let tokenId = result.value3
  let listed = result.value4
  let currency = registerCurrency(result.value5)
  let decimals = currency.decimals
  let reservePrice = coins(result.value6, decimals)
  let priceMultiplier = coins(result.value7, 2)
  let extra = result.value8
  let amount = coins(result.value9, decimals)
  let fractionsCount = result.value10
  let fractions = result.value11
  let fee = result.value12

  let creatorFee = contract.creators(id).value1

  if (listing == null) {
    let nft = registerNft(target, tokenId)

    listing = new Listing(listingId)
    listing.timestamp = timestamp
    listing.creator = creator
    listing.target = nft.id
    listing.listed = listed
    listing.paymentToken = currency.id
    listing.fee = coins(fee, 18)
    listing.priceMultiplier = priceMultiplier
    listing.extra = extra

    listing.buyersCount = 0
    listing._ref = ''
  }
  listing.reservePrice = reservePrice
  listing.creatorFee = coins(creatorFee, 18)
  listing.amount = amount
  if (fractions != ZERO_ADDRESS) {
    listing.fractions = fractions
    listing.fractionsCount = coins(fractionsCount, 6)
  }
  switch (state) {
    case 0:
      listing.status = 'CREATED'
      break
    case 1:
      listing.status = 'ACQUIRED'
      break
    case 2:
      listing.status = 'ENDED'
      break
  }
  listing.seller = seller
  {
    let result = contract.sellerPayout(id)
    listing.sellerNetAmount = coins(result.value0, decimals)
    listing.sellerFeeAmount = coins(result.value1, decimals)
    listing.creatorFeeAmount = coins(result.value2, decimals)
  }
  listing.save()
  return listing as Listing
}

function registerUserListing(address: Address, id: BigInt, buyer: Address): UserListing | null {
  let userListingId = buyer
    .toHexString()
    .concat('#')
    .concat(id.toString())
  let userListing = UserListing.load(userListingId)

  let contract = Investment.bind(address)
  let result = contract.listings(id)
  let state = result.value0
  let listed = result.value4
  let currency = registerCurrency(result.value5)
  let decimals = currency.decimals
  let reservePrice = coins(result.value6, decimals)
  let amount = coins(result.value7, decimals)
  let fractions = result.value11
  let buyerAmount = coins(contract.buyers(id, buyer), decimals)

  if (buyerAmount == ZERO_BIGDECIMAL && state < 1) {
    if (userListing != null) {
      store.remove('UserListing', userListingId)
    }
    return null
  }

  if (userListing == null) {
    userListing = new UserListing(userListingId)

    userListing.buyer = buyer
    userListing.listed = listed
    userListing.listing = id.toString()
  }
  userListing.ownership = buyerAmount.div(reservePrice)
  userListing.amount = buyerAmount
  if (fractions != ZERO_ADDRESS) {
    userListing.fractionsCount = coins(contract.buyerFractionsCount(id, buyer), 6)
  }
  userListing.save()
  return userListing as UserListing
}

function registerListingBuyers(address: Address, id: BigInt): void {
  let listingId = id.toString()
  let listing = Listing.load(listingId)
  if (listing == null) return

  if (listing._ref.length == 0) return

  let hex = address.toHexString()
  let len = hex.length
  for (let i = 0; i < listing._ref.length; i += len) {
    let hex = listing._ref.substr(i, len)
    let buyer = Address.fromString(hex)
    registerUserListing(address, id, buyer)
  }
}

function updateListingBuyers(listing: Listing | null, userListing: UserListing | null, buyer: Address): boolean {
  if (listing == null) {
    return false
  }
  let balance = userListing == null ? ZERO_BIGDECIMAL : userListing.amount
  let hex = buyer.toHexString()
  let len = hex.length
  let index = listing._ref.indexOf(hex)
  if (balance == ZERO_BIGDECIMAL) {
    if (index >= 0) {
      listing.buyersCount--
      listing._ref = listing._ref.substr(0, index) + listing._ref.substr(index + len)
      return true
    }
  } else {
    if (index < 0) {
      listing.buyersCount++
      listing._ref = listing._ref + hex
      return true
    }
  }
  return false
}

function updateLatestBlock(blockNumber: BigInt): void {
  let counter = Counter.load('LatestBlock')
  if (counter == null) {
    counter = new Counter('LatestBlock')
  }
  counter.value = blockNumber
  counter.save()
}

export function handleListed(event: Listed): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  let creator = event.params._creator
  registerListing(address, id, creator, timestamp)
}

export function handleAcquired(event: Acquired): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  registerListing(address, id, ZERO_ADDRESS, timestamp)
  registerListingBuyers(address, id)
}

export function handleJoin(event: Join): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  let buyer = event.params._buyer
  let listing = registerListing(address, id, ZERO_ADDRESS, timestamp)
  let userListing = registerUserListing(address, id, buyer)
  let modified = updateListingBuyers(listing, userListing, buyer)
  if (modified) {
    listing.save()
  }
  registerListingBuyers(address, id)
}

export function handleLeave(event: Leave): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  let buyer = event.params._buyer
  let listing = registerListing(address, id, ZERO_ADDRESS, timestamp)
  let userListing = registerUserListing(address, id, buyer)
  let modified = updateListingBuyers(listing, userListing, buyer)
  if (modified) {
    listing.save()
  }
  registerListingBuyers(address, id)
}

export function handleRelisted(event: Relisted): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  registerListing(address, id, ZERO_ADDRESS, timestamp)
  registerListingBuyers(address, id)
}

export function handlePayout(event: Payout): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  registerListing(address, id, ZERO_ADDRESS, timestamp)
}

export function handleClaim(event: Claim): void {
  updateLatestBlock(event.block.number)
  let timestamp = event.block.timestamp
  let address = event.address
  let id = event.params._listingId
  let buyer = event.params._buyer
  registerListing(address, id, ZERO_ADDRESS, timestamp)
  registerUserListing(address, id, buyer)
}
