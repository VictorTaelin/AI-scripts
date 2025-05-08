-- New Bend

module Type where

data Bits = O Bits | I Bits | E
type Name = String
type Body = Term -> Term

data Meta = Meta {
  metaName :: Name,
  metaType :: Term,
  metaSeed :: Bits,
  metaCtx  :: [Term],
  metaBody :: Body
}

data Term
  = Var Name                -- x
  | Idx Int Term            -- ^i<t>
  | Sub Term                -- x
  | Set                     -- *
  | Ann Term Term           -- <x:t>
  | Chk Term Term           -- x::t
  | Met Meta                -- ?x:T#S{C};f
  | Let Name Term Term Body -- !x:t=v;f
  | Fix Name Body           -- μx.f
  | Emp                     -- ⊥
  | Efq                     -- λ{}
  | Uni                     -- ⊤
  | One                     -- ()
  | Use Term                -- λ{():f}
  | Bit                     -- 𝔹
  | Bt0                     -- #0
  | Bt1                     -- #1
  | Bif Term Term           -- λ{#0:f;#1:t}
  | Sig Name Term Body      -- Σx:A.B
  | Tup Term Term           -- (a,b)
  | Get Term                -- λ{(,):f}
  | All Name Term Body      -- Πx:A.B
  | Lam Name Body           -- λx.f
  | App Term Term           -- (f x)
  | Fin Term                -- {l}
  | Nat                     -- ℕ
  | Zer                     -- 0
  | Suc Term                -- ↑n
  | Add Term Term           -- a+b
  | Swi Term Term           -- λ{0:z;+:s}
  | Lst Term                -- t[]
  | Vec Term Term           -- t[l]
  | Nil                     -- []
  | Con Term Term           -- h<>t
  | Mat Term Term           -- λ{[]:n;<>:c}
  | Eql Term Term Term      -- (a==b):t
  | Rfl                     -- {=}
  | Tst                     -- {:=}
  | Rwt Term                -- λ{{=}:f}

instance Show Term where
  show (Var x)        = x
  show (Idx i t)      = "^" ++ show i ++ "<" ++ show t ++ ">"
  show (Sub t)        = show t
  show Set            = "*"
  show (Ann a b)      = "<" ++ show a ++ ":" ++ show b ++ ">"
  show (Chk t ty)     = show t ++ "::" ++ show ty
  show (Met m)        = "?" ++ metaName m
  show (Let x t v f)  = "!" ++ x ++ ":" ++ show t ++ "=" ++ show v ++ ";" ++ show (f (Var x))
  show (Fix x f)      = "μ" ++ x ++ "." ++ show (f (Var x))
  show Emp            = "⊥"
  show Efq            = "λ{}"
  show Uni            = "⊤"
  show One            = "()"
  show (Use t)        = "λ{():" ++ show t ++ "}"
  show Bit            = "𝔹"
  show Bt0            = "#0"
  show Bt1            = "#1"
  show (Bif f t)      = "λ{#0:" ++ show f ++ ";#1:" ++ show t ++ "}"
  show (Sig x a b)    = "Σ" ++ x ++ ":" ++ show a ++ "." ++ show (b (Var x))
  show (Tup a b)      = "(" ++ show a ++ "," ++ show b ++ ")"
  show (Get t)        = "λ{(,):" ++ show t ++ "}"
  show (All x a b)    = "Π" ++ x ++ ":" ++ show a ++ "." ++ show (b (Var x))
  show (Lam x f)      = "λ" ++ x ++ "." ++ show (f (Var x))
  show (App f a)      = "(" ++ show f ++ " " ++ show a ++ ")"
  show (Fin t)        = "{" ++ show t ++ "}"
  show Nat            = "ℕ"
  show Zer            = "0"
  show (Suc n)        = "↑" ++ show n
  show (Add a b)      = show a ++ "+" ++ show b
  show (Swi z s)      = "λ{0:" ++ show z ++ ";+:" ++ show s ++ "}"
  show (Lst t)        = show t ++ "[]"
  show (Vec t l)      = show t ++ "[" ++ show l ++ "]"
  show Nil            = "[]"
  show (Con h t)      = show h ++ "<>" ++ show t
  show (Mat n c)      = "λ{[]:" ++ show n ++ ";<>:" ++ show c ++ "}"
  show (Eql a b t)    = "(" ++ show a ++ "==" ++ show b ++ "):" ++ show t
  show Rfl            = "{=}"
  show Tst            = "{:=}"
  show (Rwt t)        = "λ{{=}:" ++ show t ++ "}"
