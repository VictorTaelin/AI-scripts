{-./dump.txt-}
{-./Type.hs-}

-- TASK: now, create a Parser for Bend's Term Type

```haskell
module Parse where

import Data.Char (isAsciiLower, isAsciiUpper, isDigit)
import Data.Void
import Highlight (highlightError) -- Assuming this exists and works as in Kind7 example
import Text.Megaparsec
import Text.Megaparsec.Char
import qualified Data.List.NonEmpty as NE
import qualified Text.Megaparsec.Char.Lexer as L

import Type -- The new Bend Type.hs

type Parser = Parsec Void String

skip :: Parser ()
skip = L.space space1 (L.skipLineComment "//") (L.skipBlockComment "/*" "*/")

lexeme :: Parser a -> Parser a
lexeme = L.lexeme skip

symbol :: String -> Parser String
symbol = L.symbol skip

parens :: Parser a -> Parser a
parens = between (symbol "(") (symbol ")")

angles :: Parser a -> Parser a
angles = between (symbol "<") (symbol ">")

braces :: Parser a -> Parser a
braces = between (symbol "{") (symbol "}")

brackets :: Parser a -> Parser a
brackets = between (symbol "[") (symbol "]")

isNameInit :: Char -> Bool
isNameInit c = isAsciiLower c || isAsciiUpper c || c == '_'

isNameChar :: Char -> Bool
isNameChar c = isAsciiLower c || isAsciiUpper c || isDigit c || c == '_' || c == '$' -- Added $ for HVM compatibility if needed

name :: Parser String
name = lexeme $ do
  h <- satisfy isNameInit <?> "letter or underscore"
  t <- many (satisfy isNameChar <?> "letter, digit, or underscore")
  return (h : t)

formatError :: String -> ParseErrorBundle String Void -> String
formatError input bundle =
  let errorWithSource = NE.head $ fst $ attachSourcePos errorOffset (bundleErrors bundle) (bundlePosState bundle)
      err = fst errorWithSource
      pos = snd errorWithSource
      sourcePos = pstateSourcePos $ bundlePosState bundle NE.!! sourcePosPrettyLength errorWithSource
      lin = unPos (sourceLine sourcePos)
      col = unPos (sourceColumn sourcePos)
      msg = parseErrorTextPretty err
      highlighted = highlightError (lin, col) (lin, col + 1) input
  in  "\nPARSE_ERROR\n" ++ msg ++ "\n" ++
      "At line " ++ show lin ++ ", column " ++ show col ++ ":\n" ++
      highlighted
  where
    sourcePosPrettyLength :: SourcePos -> Int
    sourcePosPrettyLength sp = fromIntegral $कारों (\(SourcePos _ _ c) -> unPos c) sp - 1


parseTerm :: Parser Term
parseTerm = do
  term <- parseTermIni
  parseTermEnd term

parseTermIni :: Parser Term
parseTermIni = choice
  [ symbol "*" >> return Set
  , symbol "⊥" >> return Emp
  , symbol "⊤" >> return Uni
  , try (symbol "()" >> return One) -- try because '(' can start other things
  , symbol "𝔹" >> return Bit
  , symbol "#0" >> return Bt0
  , symbol "#1" >> return Bt1
  , symbol "ℕ" >> return Nat
  , symbol "0" >> return Zer
  , try (symbol "[]" >> return Nil) -- try because '[' can start Vec
  , symbol "μ" *> parseFix
  , symbol "Π" *> parseAll
  , symbol "Σ" *> parseSig
  , symbol "!" *> parseLet
  , symbol "?" *> parseMet
  , symbol "↑" *> (Suc <$> parseTerm)
  , symbol "^" *> parseIdx
  , parseLambdaLike -- Handles all λ forms (λx.f, λ{}, λ{():f}, etc.)
  , try parseAppParen  -- (f x y)
  , try parseTupParen  -- (a,b)
  , parens parseTerm    -- (x) for grouping
  , parseBraceWrapped -- Handles {l}, {=}, {:=}
  , parseVarOrKeyword -- Must be late, as 'name' is general
  ]

parseTermEnd :: Term -> Parser Term
parseTermEnd term = choice
  [ do { try (symbol "=="); b <- parseTerm; symbol ":"; t <- parseTerm; parseTermEnd (Eql term b t) }
  , do { symbol "<>"; t <- parseTerm; parseTermEnd (Con term t) }
  , do { symbol "::"; t <- parseTerm; parseTermEnd (Chk term t) }
  , do { symbol "+";  t <- parseTerm; parseTermEnd (Add term t) }
  , try $ do { lookAhead (symbol "[]" >> notFollowedBy (satisfy isNameChar)); symbol "[]"; parseTermEnd (Lst term) }
  , do { content <- brackets parseTerm; parseTermEnd (Vec term content) }
  , return term
  ]

parseVarOrKeyword :: Parser Term
parseVarOrKeyword = do
  k <- name
  case k of
    "Set"   -> return Set
    "Nat"   -> return Nat
    "Bit"   -> return Bit
    "True"  -> return Bt1
    "False" -> return Bt0
    _       -> return (Var k)

parseIdx :: Parser Term
parseIdx = Idx <$> lexeme L.decimal <*> angles parseTerm

parseAnn :: Parser Term -- Not directly in parseTermIni, but used by other parsers if needed, or could be an operator
parseAnn = angles $ Ann <$> parseTerm <*> (symbol ":" *> parseTerm)

parseBits :: Parser Bits
parseBits = choice
  [ symbol "E" >> return E
  , symbol "O" >> O <$> parseBits
  , symbol "I" >> I <$> parseBits
  ]

parseMet :: Parser Term
parseMet = do
  metaName <- name
  symbol ":"
  metaType <- parseTerm
  metaSeed <- option E (symbol "#" *> lexeme parseBits)
  metaCtx  <- option [] (braces (parseTerm `sepBy` symbol ","))
  symbol ";"
  fBodyTerm <- parseTerm
  return $ Met (Meta metaName metaType metaSeed metaCtx (\_ -> fBodyTerm))

parseLet :: Parser Term
parseLet = do
  x <- name
  symbol ":"
  t <- parseTerm
  symbol "="
  v <- parseTerm
  symbol ";"
  fBodyTerm <- parseTerm
  return $ Let x t v (\_ -> fBodyTerm)

parseFix :: Parser Term
parseFix = do
  x <- name
  symbol "."
  fBodyTerm <- parseTerm
  return $ Fix x (\_ -> fBodyTerm)

parseLambdaLike :: Parser Term
parseLambdaLike = symbol "λ" *> choice
  [ braces $ choice
    [ try (symbol "}" >> return Efq)
    , try (symbol "():" *> parseTerm <* symbol "}" >>= \f -> return (Use f))
    , try (symbol "#0:" *> parseTerm <* symbol ";#1:" <*> parseTerm <* symbol "}" >>= \(f,t) -> return (Bif f t))
    , try (symbol "(,):" *> parseTerm <* symbol "}" >>= \f -> return (Get f))
    , try (symbol "[]:" *> parseTerm <* symbol ";<>:" <*> parseTerm <* symbol "}" >>= \(n,c) -> return (Mat n c))
    , try (symbol "0:" *> parseTerm <* symbol ";+:" <*> parseTerm <* symbol "}" >>= \(z,s) -> return (Swi z s))
    , symbol "{=}:" *> parseTerm <* symbol "}" >>= \f -> return (Rwt f)
    ]
  , do -- Normal Lam: λx.f
      x <- name
      symbol "."
      bodyTerm <- parseTerm
      return $ Lam x (\_ -> bodyTerm)
  ]

parseSig :: Parser Term
parseSig = do
  x <- name
  symbol ":"
  a <- parseTerm
  symbol "."
  bBodyTerm <- parseTerm
  return $ Sig x a (\_ -> bBodyTerm)

parseAll :: Parser Term
parseAll = do
  x <- name
  symbol ":"
  a <- parseTerm
  symbol "."
  bBodyTerm <- parseTerm
  return $ All x a (\_ -> bBodyTerm)

parseAppParen :: Parser Term
parseAppParen = parens (foldl App <$> parseTerm <*> many parseTerm)

parseTupParen :: Parser Term
parseTupParen = parens (Tup <$> parseTerm <* symbol "," <*> parseTerm)

parseBraceWrapped :: Parser Term
parseBraceWrapped = symbol "{" *> choice
  [ try (symbol "=" *> symbol "}" *> return Rfl)
  , try (symbol ":=" *> symbol "}" *> return Tst)
  , Fin <$> parseTerm <* symbol "}"
  ]

-- Entry points
doParseTerm :: String -> String -> Either String Term
doParseTerm filename code =
  case parse (skip *> parseTerm <* eof) filename code of
    Left bundle -> Left (formatError code bundle)
    Right term  -> Right term -- Assuming 'bind' is a separate step if needed for HOAS bodies

doReadTerm :: String -> Term
doReadTerm input =
  case doParseTerm "<interactive>" input of
    Left err   -> error err
    Right term -> term

```
