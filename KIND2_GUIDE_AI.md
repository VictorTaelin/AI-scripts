# GUIDE FOR THE KIND2 LANGUAGE

Kind2 is a minimal proof language based on the Calculus of Constructions. It is
similar to Agda in capabilities, but has a raw syntax, and a much smaller core.
Instead of a native datatype system, it uses λ-encodings to represent data. To
make inductive proofs, it includes a lightweight primitive called Self Types.

## Kind2 Core Language

All of Kind2 desugars to the following small core:

```
Term ::=
  | all : ∀(x: A) B // the dependent function type (also called Pi Type)
  | lam : λx f      // an inline function (also called lambda)
  | app : (f x y z) // function application (Lisp-style, MANDATORY parenthesis)
  | ann : {x :: T}  // an inline annotation (type hint)
  | slf : $(x: A) T // self type, for λ-encoded inductive datatypes (see later)
  | ins : ~t        // self inst, to consume a self type (see later)
  | ref : <name>    // top-level reference (expands to its definition)
  | let : let x = t // local definition, creates a new variable (runtime cloning)
  | use : use x = t // local definition, substitutes statically (no runtime cloning)
  | set : *         // the only universe (kind has type-in-type)
  | num : <value>   // a numeric literal (48-bit unsigned integer)
  | op2 : (+ x y)   // a numeric operation (Lisp-style, MANDATORY parenthesis)
  | swi : see below // a numeric pattern-match (with zero and succ cases)
  | u48 : U48       // a numeric type
  | hol : ?a        // a typed hole, for debugging and context inspection
  | met : _         // an unification metavar (is solved by the checker)
  | var : <name>    // a variable
```

## Kind2 Syntax

Since Kind2's core is so simple, it comes with many syntax sugars.

### Top-Level Function

Every .kind2 file must define ONE top-level function:

```
func <p0: P0> <p1: P1> ...
- arg0: typ0
- arg1: typ1
- ...
: ret_typ

body
```

Where:
- p0, p1... are erased arguments
- arg0, arg1... are the function arguments
- ret_typ is the returned type
- body is the function's body

### Top-Level Datatype

Alternatively, a .kind2 tile can also define an inductive datatype:

```
data Name <p0: P0> <p1: P1> ... (i0: I0) (i1: I1) ...
| ctr0 (f0: F0) (f1: F1) ... : (Name p0 p1 ... i0 i1 ...)
| ctr1 (f0: F0) (f1: F1) ... : (Name p0 p1 ... i0 i1 ...)
| ...
```

Where:
- p0, p1... are parameters
- i0, i1... are indices
- ctr0, ctr1... are constructors
- f0, f1... are fields

Top-Level datatypes desugar to λ-encodings. The λ-encoded constructors must be
created manually, in separate files. See examples below.

### Names, Paths and Use Aliases

Kind2 doesn't need imports. Every file defines a single top-level definition,
which can be addressed from any other file via its full path. Example:

```
book/Nat/add/comm.kind2
```

Defines:

```
Nat/add/comm
```

Which can be accessed directly from any other file, no 'import' needed.

To shorten names, the 'use' declaration can be added to the beginning of a file:

```
use Nat/{succ,zero}
```

This locally expands 'succ' and 'zero' to 'Nat/succ' and 'Nat/zero'. It is
specially useful to avoid typing full constructor names on 'match' cases.

NOTE: when a definition is not found in `Foo/Bar.kind2`, Kind2 will try to
look for it on `Foo/Bar/_.kind2`. The `_` is just a placeholder and is NOT
part of the definition's name.

### Pattern-Matching

To eliminate a datatype, the match syntax can be used:

```
match x = expr with (a0: A0) (a1: A1) ... {
  Type/ctr0: ret0
  Type/ctr1: ret1
  ...
}: motive
```

Where:
- x is the *name* of the scrutinee
- expr is the *value* of scrutinee (optional)
- a0, a1... are arguments to be *linearly passed down* to the branches (as an optimization, and helps proving)
- ctr0, ctr1... are the matched cases
- ret0, ret1... are the returned bodies of each case (with ctr fields available)
- the motive is optional (useful for theorem proving)

Kind will automatically make constructor fields available on their respective
cases, named `<scrutinee_name>.<field_name>`. For example, on the `succ` case of
Nat, if the scrutinee is called `num`, `num.pred` will be available.

For this syntax to work, a top-level 'Type/match' definition must be provided.

The 'match' keyword can be replaced by 'fold', to auto-recurse.

This desugars to a self-inst and function applications.

### Numeric Pattern-Matching

For matching on native U48 numbers, Kind2 provides a special syntax:

```
switch x = expr {
  0: zero_case
  _: succ_case
}: motive
```

### Note on Parameters and Metavars 

Top-level definitions can have N parameters, or erased arguments. Example:

```
// Pair/swap.kind2
swap <A> <B>
- pair: (Pair A B)
...
```

There are two ways to call these functions.

1. Filling the parameters explicitly:

```
(swap Nat (List Nat) (Pair/new Nat (List Nat) Nat/zero (List/nil Nat)))
```

2. Using metavars (`_`) to fill the parameters:

```
(swap _ _ (Pair/new _ _ Nat/zero (List/nil _)))
```

As you can see, using metavars is much more concise. As a rule of thumb, always
use metavars on the function body, but write it fully on its arglist. Remember
to always count the arguments: you need one metavar (`_`) per parameter (`<>`).

### Other Sugars

- Lists: `[a, b, c]` (desugars to cons/nil)
- Strings: `"foo"` (desugars to lists of u48 codepoints)
- Equality: `{a = b}` (desugars to `(Equal _ a b)`)
- Function: `A -> B` (desugars to `∀(x_: A) B`)
- Comments: `// comment here`

## Kind2 Examples

### Nat/_.kind2

```
/// Defines the natural numbers as an inductive datatype.
///
/// # Constructors
///
/// * `succ` - Represents the successor of a natural number (x+1).
/// * `zero` - Represents the natural number zero (0).

data Nat
| succ (pred: Nat)
| zero
```

### Nat/succ.kind2

```
/// Constructs the successor of a natural number.
///
/// # Input
///
/// * `n` - The natural number to which we add 1.
///
/// # Output
///
/// The successor of `n`.

succ
- n: Nat
: Nat

~λP λsucc λzero (succ n)
```

### Nat/zero.kind2

```
/// Represents the zero natural number.
///
/// # Output
///
/// The zero natural number.

zero
: Nat

~λP λsucc λzero zero
```

### Nat/match.kind2

```
/// Provides a way to pattern match on natural numbers.
///
/// # Inputs
///
/// * `P` - The motive of the elimination.
/// * `s` - The successor case.
/// * `z` - The zero case.
/// * `n` - The natural number to match on.
///
/// # Output
///
/// The result of the elimination.

match
- P: Nat -> *
- s: ∀(pred: Nat) (P (Nat/succ pred))
- z: (P Nat/zero)
- n: Nat
: (P n)

(~n P s z)
```

### Nat/add.kind2

```
/// Adds two natural numbers.
///
/// # Inputs
///
/// * `a` - The first natural number.
/// * `b` - The second natural number.
///
/// # Output
///
/// The sum of `a` and `b`.

use Nat/{succ,zero}

add
- a: Nat
- b: Nat
: Nat

match a {
  succ: (succ (add a.pred b))
  zero: b
}
```

### Nat/equal.kind2

```
/// Checks if two natural numbers are equal.
///
/// # Inputs
///
/// * `a` - The first natural number.
/// * `b` - The second natural number.
///
/// # Output
///
/// `true` if `a` and `b` are equal, `false` otherwise.

use Nat/{succ,zero}
use Bool/{true,false}

equal
- a: Nat
- b: Nat
: Bool

match a with (b: Nat) {
  succ: match b {
    succ: (equal a.pred b.pred)
    zero: false
  }
  zero: match b {
    succ: false
    zero: true
  }
}
```

### List/_.kind2

```
/// Defines a generic list datatype.
///
/// # Parameters
///
/// * `T` - The type of elements in the list.
///
/// # Constructors
///
/// * `cons` - Adds an element to the front of a list.
/// * `nil` - Represents an empty list.

data List <T>
| cons (head: T) (tail: (List T))
| nil
```

### List/cons.kind2

```
/// Constructs a new list by adding an element to the front of an existing list.
///
/// # Parameters
///
/// * `T` - The type of elements in the list.
///
/// # Inputs
///
/// * `head` - The element to add to the front of the list.
/// * `tail` - The existing list.
///
/// # Output
///
/// A new list with `head` as its first element, followed by the elements of `tail`.

cons <T>
- head: T
- tail: (List T)
: (List T)

~λP λcons λnil (cons head tail)
```

### List/nil.kind2

```
/// Constructs an empty list.
///
/// # Parameters
///
/// * `T` - The type of elements in the list.
///
/// # Output
///
/// An empty list of type `(List T)`.

nil <T>
: (List T)

~λP λcons λnil nil
```

### List/match.kind2

```
/// Provides a way to pattern match on lists.
///
/// # Parameters
///
/// * `A` - The type of elements in the list.
///
/// # Inputs
///
/// * `P` - The motive of the elimination.
/// * `c` - The cons case.
/// * `n` - The nil case.
/// * `xs` - The list to match on.
///
/// # Output
///
/// The result of the elimination.

match <A>
- P: (List A) -> *
- c: ∀(head: A) ∀(tail: (List A)) (P (List/cons A head tail))
- n: (P (List/nil A))
- xs: (List A)
: (P xs)

(~xs P c n)
```

### List/fold.kind2

```
/// Folds a list from left to right.
///
/// # Parameters
///
/// * `A` - The type of elements in the list.
///
/// # Inputs
///
/// * `P` - The type of the accumulator and result.
/// * `c` - The function to apply to each element and the accumulator.
/// * `n` - The initial value of the accumulator.
/// * `xs` - The list to fold.
///
/// # Output
///
/// The result of folding the list.

use List/{cons,nil}

List/fold <A> (P: *)
- c: A -> P -> P
- n: P
- xs: (List A)
: P

match xs {
  cons: (c xs.head (List/fold _ P c n xs.tail))
  nil: n
}
```

### List/map.kind2

```
/// Applies a function to each element of a list.
///
/// # Parameters
///
/// * `A` - The type of elements in the input list.
/// * `B` - The type of elements in the output list.
///
/// # Inputs
///
/// * `xs` - The input list.
/// * `fn` - The function to apply to each element.
///
/// # Output
///
/// A new list with the function applied to each element of the input list.

use List/{cons,nil}

map <A> <B>
- xs: (List A)
- fn: A -> B
: (List B)

match xs {
  cons:
    let head = (fn xs.head)
    let tail = (List/map _ _ xs.tail fn)
    (cons _ head tail)
  nil:
    (nil _)
}
```

### List/filter.kind2

```
/// Filters a list, keeping only elements that satisfy the given condition.
///
/// # Parameters
///
/// * `A` - The type of elements in the list.
///
/// # Inputs
///
/// * `cond` - A function that takes an element of type A and returns a Bool.
/// * `list` - The input list of type (List A).
///
/// # Output
///
/// A new list containing only the elements for which `cond` returns `true`.

use List/{cons,nil}
use Bool/{true,false}

filter <A>
- cond: A -> Bool
- list: (List A)
: (List A)

match list {
  nil:
    (nil _)
  cons:
    let test = (cond list.head)
    let head = match test { true: (cons _ list.head) false: λx x }: (List A) -> (List A)
    let tail = (filter _ cond list.tail)
    (head tail)
}
```

### STOP

Take a moment to notice how EVERY constructor and function application in Kind2
requires a parenthesis, just like Lisp. Trying to write `(foo x y)` without the
surrounding parenthesis is a syntax error. Confirm this is true and move on.

Also, note that ERASED arguments can usually be inferred, so, a metavar ('_')
can be used. Example: '(func _ _ ... arg0 arg1 ...)' can be writen instead of
'(func A B ... arg0 arg1 ...)'. Prefer metavars on the body of the function.

### Sigma/_.kind2

```
/// Defines a dependent pair type, also known as a sigma type.
///
/// # Parameters
///
/// * `A` - The type of the first component.
/// * `B` - A function type `A -> *` that determines the type of the second component based on the first.
///
/// # Constructor
///
/// * `new` - Creates a new sigma type instance.

data Sigma <A: *> <B: A -> *>
| new (fst: A) (snd: (B fst))
```

### Equal/_.kind2

```
/// Defines propositional equality between two values of the same type.
///
/// # Parameters
///
/// * `T` - The type of the values being compared.
///
/// # Parameters
///
/// * `a` - The first value.
/// * `b` - The second value.
///
/// # Constructor
///
/// * `refl` - Represents reflexivity, i.e., that `a` equals itself.

data Equal <T> (a: T) (b: T)
| refl (a: T) : (Equal T a a)
```

### Equal/refl.kind2

```
/// Constructs a proof of reflexivity for propositional equality.
///
/// # Parameters
///
/// * `A` - The type of the value.
///
/// # Input
///
/// * `x` - The value for which to construct the reflexivity proof.
///
/// # Output
///
/// A proof that `x` is equal to itself.

refl <A>
- x: A
: (Equal A x x)

~ λP λrefl (refl x)
```

### Equal/apply.kind2

```
/// Applies a function to both sides of an equality proof.
///
/// # Parameters
///
/// * `A` - The type of the compared values.
/// * `B` - The type of the compared values after applying the function.
/// * `a` - The first compared value.
/// * `b` - The second compared value.
///
/// # Inputs
///
/// * `f` - The function to apply to both sides of the equality.
/// * `e` - The proof of equality between `a` and `b`.
///
/// # Output
///
/// A proof that `(f a)` is equal to `(f b)`.

use Equal/refl

apply <A: *> <B: *> <a: A> <b: A>
- f: A -> B
- e: (Equal A a b)
: (Equal B (f a) (f b))

match e {
  refl: ~λPλe(e (f e.a))
}: (Equal B (f e.a) (f e.b))
