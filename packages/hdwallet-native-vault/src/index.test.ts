import * as native from "@shapeshiftoss/hdwallet-native";
import * as idb from "idb-keyval";
// import * as jose from "jose";
import * as uuid from "uuid";

import { Vault, GENERATE_MNEMONIC } from ".";
import { fromAsyncIterable } from './asyncMap';
import { deterministicGetRandomValues } from "./deterministicGetRandomValues.test";
import { MockVault } from './test/mockVault.skip';
import { RawVault } from './rawVault';
import { ISealableVaultFactory, IVault } from "./types";
import { keyStoreUUID, vaultStoreUUID } from "./util";

const keyStore = idb.createStore(keyStoreUUID, "keyval");
const vaultStore = idb.createStore(vaultStoreUUID, "keyval");

jest.setTimeout(30 * 1000);

const realCrypto = require("crypto").webcrypto as Crypto;
let mockGetRandomValues: <T extends ArrayBufferView | null>(array: T) => Promise<T>;
async function resetGetRandomValues() {
  mockGetRandomValues = await deterministicGetRandomValues(realCrypto);
}

type ParametersExceptFirst<F> = F extends (arg0: any, ...rest: infer R) => any ? R : never;
async function thereCanBeOnlyOne<T extends IVault, U extends ISealableVaultFactory<T>>(factory: U, ...args: ParametersExceptFirst<U["open"]>): Promise<T> {
  const ids = await fromAsyncIterable(await factory.list());
  if (ids.length === 0) throw new Error("can't find a vault");
  if (ids.length > 1) throw new Error(`expected a single vault; found ${ids.length}: ${ids}`);
  return await factory.open(ids[0], ...(args as any));
}

let prepareOnce: () => void;
const preparedOnce = new Promise<void>(resolve => prepareOnce = resolve).then(async () => {
  await resetGetRandomValues();
  await RawVault.prepare({
    crypto: {
      subtle: realCrypto.subtle,
      async getRandomValues<T extends ArrayBufferView | null>(array: T): Promise<T> {
        return await mockGetRandomValues(array);
      },
    },
    performance: require("perf_hooks").performance,
  })
  await RawVault.defaultArgonParams
})

function testVaultImpl(name: string, Vault: ISealableVaultFactory<IVault>) {
  describe(name, () => {
    beforeAll(async () => {
      prepareOnce();
      await preparedOnce;
      await Vault.prepare();
      for await (const id of await Vault.list()) await Vault.delete(id)
    });

    beforeEach(async () => {
      await resetGetRandomValues();
    });

    it("should allow repeated calls to prepare() with no options", async () => {
      await expect(Vault.prepare()).resolves.not.toThrow();
      await expect(Vault.prepare()).resolves.not.toThrow();
    });

    it("should create a new vault", async () => {
      expect((await fromAsyncIterable(await Vault.list())).length).toBe(0);

      const vault = await Vault.create();
      await vault.setPassword("foobar");
      await vault.set("foo", "bar");
      await (await vault.meta).set("name", "default");
      expect(await (await vault.meta).get("name")).toBe("default");
      await vault.save();

      expect((await fromAsyncIterable(await Vault.list())).length).toBe(1);
      expect(await (await vault.meta).get("name")).toBe("default");

      console.log("keyStore", await idb.entries(keyStore));
      console.log("vaultStore", await idb.entries(vaultStore));
    });

    it("should open a vault", async () => {
      const vaultIDs = await fromAsyncIterable(await Vault.list());
      expect(vaultIDs.length).toBe(1);
      const vault = await Vault.open(vaultIDs[0], "foobar");
      // console.log(jose.decodeProtectedHeader((await idb.get(vaultIDs[0], vaultStore))!));
      // console.log("entries", await fromAsyncIterable(await vault.entries()));
      expect(await vault.get("foo")).toBe("bar");
      expect(uuid.validate(await vault.id)).toBe(true);
      expect(await (await vault.meta).size).toBe(1);
      expect(await (await vault.meta).get("name")).toBe("default");
    });

    it("should store a mnemonic", async () => {
      const vault = await thereCanBeOnlyOne(Vault, "foobar");
      await vault.set("#mnemonic", "all all all all all all all all all all all all");
      await vault.save();
      const mnemonic = await vault.get<native.crypto.Isolation.Engines.Default.BIP39.Mnemonic>("#mnemonic");
      expect(mnemonic).toBeInstanceOf(native.crypto.Isolation.Engines.Default.BIP39.Mnemonic);
      expect(
        Buffer.from(await (await (await mnemonic!.toSeed()).toMasterKey()).getPublicKey()).toString("hex")
      ).toMatchInlineSnapshot(`"03e3b30e8c21923752a408242e069941fedbaef7db7161f7e2c5f3fdafe7e25ddc"`);
    });

    it("should retreive the mnemonic", async () => {
      const vaultIDs = await fromAsyncIterable(await Vault.list());
      expect(vaultIDs.length).toBe(1);
      const vault = await Vault.open(vaultIDs[0], "foobar");
      const mnemonic = await vault.get<native.crypto.Isolation.Engines.Default.BIP39.Mnemonic>("#mnemonic");
      expect(mnemonic).toBeInstanceOf(native.crypto.Isolation.Engines.Default.BIP39.Mnemonic);
      expect(
        Buffer.from(await (await (await mnemonic!.toSeed()).toMasterKey()).getPublicKey()).toString("hex")
      ).toMatchInlineSnapshot(`"03e3b30e8c21923752a408242e069941fedbaef7db7161f7e2c5f3fdafe7e25ddc"`);
    });

    it("should store metadata", async () => {
      const vault = await thereCanBeOnlyOne(Vault, "foobar");
      await (await vault.meta).set("bar", "baz")
      expect(await (await vault.meta).get("bar")).toBe("baz")
      await vault.save()
    })

    it("should retreive metadata from the vault instance", async () => {
      const vault = await thereCanBeOnlyOne(Vault, "foobar");
      expect(await (await vault.meta).get("bar")).toBe("baz")
    })

    it("should retreive metadata with the static method", async () => {
      const id = await (await thereCanBeOnlyOne(Vault)).id
      expect(await (await Vault.meta(id))?.get("bar")).toBe("baz")
    })

    describe("ISealable", () => {
      it("should be unwrappable before being sealed", async () => {
        const vault = await thereCanBeOnlyOne(Vault, "foobar", false);
        expect(await vault.sealed).toBe(false);
        const unwrapped = await vault.unwrap();
        expect(await unwrapped.get("#mnemonic")).toBe("all all all all all all all all all all all all");
      })

      describe("the unwrapped vault", () => {
        it("should expose the mnemonic via entries()", async () => {
          const vault = await thereCanBeOnlyOne(Vault, "foobar", false);
          const unwrapped = await vault.unwrap();
          const entries = await fromAsyncIterable(await unwrapped.entries());
          expect(entries).toContainEqual(["#mnemonic", "all all all all all all all all all all all all"]);
        })
        it("should expose the mnemonic via values()", async () => {
          const vault = await thereCanBeOnlyOne(Vault, "foobar", false);
          const unwrapped = await vault.unwrap();
          const values = await fromAsyncIterable(await unwrapped.values());
          expect(values).toContain("all all all all all all all all all all all all");
        })
      })

      it("should not be unwrappable after being sealed", async () => {
        const vault = await thereCanBeOnlyOne(Vault, "foobar", false);
        expect(await vault.sealed).toBe(false);
        await vault.seal();
        expect(await vault.sealed).toBe(true);
        await expect(() => vault.unwrap()).rejects.toThrowErrorMatchingInlineSnapshot(`"can't unwrap a sealed vault"`);
      });
    });

    it("should generate a fresh, random mnemonic when provided with the GENERATE_MNEMONIC magic", async () => {
      const vault = await Vault.create("foobar", false);
      expect(await vault.id).toMatchInlineSnapshot(`"8f9c0a54-7157-42f7-87f1-361325aaf80a"`);
      await vault.set("#mnemonic", GENERATE_MNEMONIC);
      await vault.save();

      const mnemonic = await vault.get<native.crypto.Isolation.Engines.Default.BIP39.Mnemonic>("#mnemonic");
      expect(mnemonic).toBeInstanceOf(native.crypto.Isolation.Engines.Default.BIP39.Mnemonic);
      expect(
        Buffer.from(await (await (await mnemonic!.toSeed()).toMasterKey()).getPublicKey()).toString("hex")
      ).toMatchInlineSnapshot(`"02576bde4c55b05886e56eeeeff304006352f935b6dfc1c409f7eae521dbc5558e"`);

      const unwrappedMnemonic = await (await vault.unwrap()).get<string>("#mnemonic");
      expect(unwrappedMnemonic).toMatchInlineSnapshot(
        `"hover best act jazz romance ritual six annual pottery coral write paddle"`
      );
    });

    it("should retrieve the random mnemonic generated by the GENERATE_MNEMONIC magic", async () => {
      const vault = await Vault.open("8f9c0a54-7157-42f7-87f1-361325aaf80a", "foobar", false);

      const mnemonic = await vault.get<native.crypto.Isolation.Engines.Default.BIP39.Mnemonic>("#mnemonic");
      expect(mnemonic).toBeInstanceOf(native.crypto.Isolation.Engines.Default.BIP39.Mnemonic);
      expect(
        Buffer.from(await (await (await mnemonic!.toSeed()).toMasterKey()).getPublicKey()).toString("hex")
      ).toMatchInlineSnapshot(`"02576bde4c55b05886e56eeeeff304006352f935b6dfc1c409f7eae521dbc5558e"`);

      expect(await (await vault.unwrap()).get("#mnemonic")).toMatchInlineSnapshot(
        `"hover best act jazz romance ritual six annual pottery coral write paddle"`
      );
    });
  });
}

testVaultImpl("Vault", Vault)
testVaultImpl("MockVault", MockVault)
