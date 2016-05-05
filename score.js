import "babel-polyfill";
import {flatMap, forEach, map, sum} from 'lodash';
var jsdom = require("jsdom");


// Get a key of a map, first setting it to a default value if it's missing.
function getDefault(map, key, defaultMaker) {
    var value = map.get(key);
    var defaultValue;

    if (value === undefined) {
        defaultValue = defaultMaker();
        map.set(key, defaultValue);
        return defaultValue;
    }
    return value;
}


// Construct a collection of rules that we can query on the type of
// node they operate on.
function ruleset(...rules) {
    var rulesByInputType = new Map();  // [someInputType: [rule, ...]]

    // File each rule under its input type:
    forEach(rules,
            rule => getDefault(rulesByInputType, rule.source.inputType, () => []).push(rule));

    return {
        // Iterate over a DOM tree or subtree, building up a knowledgebase, a
        // data structure holding scores and annotations for interesting
        // elements. Return the knowledgebase.
        //
        // This is the "rank" portion of the rank-and-yank algorithm.
        score: function (tree) {
            var kb = knowledgebase();
            var nonterminals;  // [[node, type], [node, type], ...]
            var inNode, inType, outFacts;

            // Merge adjacent text nodes so inlineTexts() and similar rankers
            // can be simple.
            tree.normalize();

            // Introduce the whole DOM into the KB as type 'dom' to get things
            // started:
            nonterminals = [[{tree: tree}, 'dom']];

            // While there are new facts, run the applicable rules over them to
            // generate even newer facts. Repeat until everything's fully
            // digested. Rules run in no particular guaranteed order.
            while (nonterminals.length) {
                [inNode, inType] = nonterminals.pop();
                for (let rule of rulesByInputType.get(inType)) {
                    outFacts = resultsOf(rule, inNode, inType);
                    for (let fact of outFacts) {
                        outNode = kb.nodeForElement(fact.element);

                        // No matter whether or not this type has been emitted
                        // before for this node, we multiply the score. We want
                        // to be able to add rules that refine the scoring of a
                        // node, without having to rewire the path of types
                        // that winds through the ruleset.
                        outNode.score *= fact.scoreMultiplier;

                        // Add a new type annotation to a node--but only if
                        // there wasn't an equivalent one already there;
                        // otherwise there's no point.
                        //
                        // You might argue that we might want to modify an
                        // existing scribble here, but that would be a bad
                        // idea. Scribbles for a given type should be
                        // considered immutable once laid down. Otherwise, the
                        // order of execution of same-typed rules could matter,
                        // hurting pluggability. Emit a new type and a new
                        // scribble if you want to do that.
                        //
                        // Also, choosing not to add a new fact to nonterminals
                        // when we're not adding a new type saves the work of
                        // running the rules against it, which would be
                        // entirely redundant and perform no new work (unless
                        // the rankers were nondeterministic, but don't do
                        // that).
                        if (!outNode.types.has(fact.type)) {
                            outNode.types.set(fact.type, fact.scribbles);
                            kb.indexNodeByType(outNode, fact.type);  // TODO: better encapsulation rather than indexing explicitly
                            nonterminals.push([outNode, fact.type]);
                        }
                    }
                }
            }
            return kb;
        }
    };
}


// Construct a container for storing and querying facts, where a fact has a
// type (used to dispatch further rules upon) and a result (arbitrary at the
// moment, generally containing a score).
function knowledgebase() {
    var nodesByType = new Map();  // Map{'texty' -> [NodeA],
                                  //     'spiffy' -> [NodeA, NodeB]}
                                  // NodeA = {element: <someElement>,
                                  //
                                  //          // Global nodewide score. Add
                                  //          // custom ones with scribbles if
                                  //          // you want.
                                  //          score: 8,
                                  //
                                  //          // Types is a map of type names to scribbles:
                                  //          types: Map{'texty' -> {ownText: 'blah',
                                  //                                 someOtherScribble: 'foo',
                                  //                                 someCustomScore: 10},
                                  //                     // This is an empty scribble:
                                  //                     'fluffy' -> undefined}}
    var nodesByElement = new Map();

    return {
        // Return the "node" (our own data structure that we control) that
        // corresponds to a given DOM element, creating one if necessary.
        nodeForElement: function (element) {
            return getDefault(nodesByElement,
                              element,
                              () => ({element: element,
                                      score: 1,
                                      types: new Map()}));
        },

        // Let the KB know that a new type has been added to an element.
        indexNodeByType: function (node, type) {
            getDefault(nodesByType, type, () => []).push(node);
        }
    };
}


// A ranker returns a collection of 0 or more facts, each of which comprises an optional score multiplier, an element (defaulting to the input one), a type (required on dom() rules, defaulting to the input one on typed() rules), and optional scribbles. This enables a ranker to walk around the tree and say things about other nodes than the input one.
function someRanker(node) {
    return [{scoreMultiplier: 3,
             element: node.element,
             type: 'texty',
             scribbles: {}}];
}


// Apply a rule (as returned by a call to rule()) to a fact, and return the
// new facts that result.
function resultsOf(rule, node, type) {
    // If more types of rule pop up someday, do fancier dispatching here.
    return rule.source.kind === 'typed' ? resultsOfTypedRule(rule, node, type) : resultsOfDomRule(rule, node);
}


// Pull the DOM tree off the special property of the root "dom" fact, and query
// against it.
function *resultsOfDomRule(rule, specialDomNode) {
    // Use the special "tree" property of the special starting node:
    var matches = specialDomNode.tree.querySelectorAll(rule.selector);
    var newFacts;

    for (let element of matches) {
        // Yield a new fact:
        newFacts = rule.ranker(kb.nodeForElement(element));
        // 1 score per Node is plenty. That simplifies our data, our rankers, our type system (since we don't need to represent score axes), and our engine. If somebody wants more score axes, they can fake it themselves with scribbles, thus paying only for what they eat. (We can even provide functions that help with that.) Most rulesets will probably be concerned with scoring only 1 thing at a time anyway. So, rankers return a score multiplier + 0 or more new types with optional scribbles. Facts can never be deleted from the KB by rankers (or order would start to matter); after all, they're *facts*.
        for (let fact of newFacts) {
            if (newFact.type === undefined) {
                throw "Rankers of dom() rules must return a type in each fact. Otherwise, there is no way for that fact to be used later.";
            }
            if (newFact.element === undefined) {
                newFact.element = element;
            }
            yield newFact;
        }
    }
}


function *resultsOfTypedRule(rule, node, type) {
    var newFacts = rule.ranker(node);

    for (let fact of newFacts) {
        if (fact.scoreMultiplier === undefined) {
            fact.scoreMultiplier = 1;
        }
        // If the ranker didn't specify a different element, assume it's
        // talking about the one we passed in:
        if (fact.element === undefined) {
            fact.element = node.element;
        }
        if (fact.type === undefined) {
            fact.type = type;
        }
        yield fact;
    }
}


// TODO: For the moment, a lot of responsibility is on the rankers to return a
// pretty big data structure of up to 4 properties. This is a bit verbose for
// an arrow function (as I hope we can use most of the time) and the usual case
// will probably be returning just a score multiplier. Make that case more
// concise.


// change vocab from "scribbles" to "notes": shorter and more accurate


// Iterate, depth first, over a DOM node.
// shouldTraverse - a function on a node saying whether we should include it
//     and its children
function *walk(node, shouldTraverse) {
    if (shouldTraverse(node)) {
        yield node;
        for (let child of node.childNodes) {
            for (let w of walk(child, shouldTraverse)) {
                yield w;
            }
        }
    }
}


// Yield strings of text nodes within a normalized DOM node and its children,
// without venturing into any contained block elements.
function *inlineTexts(node) {
    for (let child of walk(node, node => !(isBlock(node) ||
                                           node.tagName === 'script' &&
                                           node.tagName === 'style'))) {
        if (child.nodeType === child.TEXT_NODE) {
            // .wholeText is what needs the DOM tree to be normalized.
            // Otherwise, it'll return the contents of adjacent text nodes,
            // too, and we'll get those contents a second time when we traverse
            // to them.
            yield child.wholeText;
        }
    }
}


function collapseWhitespace(str) {
    return str.replace(/\s{2,}/g, " ");
}


// Return a fact that scores a DOM node based on how much it resembles a
// maximally tight block element full of text.
function paragraphish(node) {
    return {
        type: 'paragraphish',
        score: sum(map(inlineTexts(node),
                       str => collapseWhitespace.length))
    };
}


// Return a condition that uses a DOM selector to find its matches from the
// original DOM tree.
//
// For consistency, Nodes will still be delivered to the transformers, but they'll have empty types and score = 1. If the ranker returns null, bail out and don't add the node to any indices.
function dom(selector) {
    return {
        kind: 'dom',
        inputType: 'dom',
        selector: selector
    };
}


// Return a condition that discriminates on nodes of the knowledgebase by type.
function typed(inputType) {
    return {
        kind: 'typed',
        inputType: inputType
    };
}


function rule(source, ranker) {
    return {
        source: source,
        ranker: ranker
    };
}


function fancyExample() {
    var doc = jsdom.jsdom(
        '<p><a class="ad" href="https://github.com/tmpvar/jsdom">jsdom!</a></p>'
    );
    var rules = ruleset(
        // Score by length of directly contained text:
        rule(dom('p,div'), paragraphish),

        // Give bonus for being in a semantically appropriate tag:
        rule(typed('paragraphish'), node => node.el.tagName == 'p' ? 1.5 : 1)
    );
    var knowledgebase = rules.score(doc);
}


// NEXT: Get a trivial example running.
function simpleExample() {
    var doc = jsdom.jsdom(
        '<p><a class="good" href="https://github.com/tmpvar/jsdom">jsdom!</a><a class="bad" href="https://github.com/tmpvar/jsdom">jsdom!</a></p>'
    );
    var rules = ruleset(
        rule(dom('a[class=good]'), node => ({scoreMultiplier: 2, type: 'anchor'}))
    );
    var knowledgebase = rules.score(doc);
}


simpleExample();


// This set of rules might be the beginning of something that works. (It's modeled after what I do when I try to do this by hand: I look for balls of black text, and I look for them to be near each other, generally siblings: a "cluster" of them.) Order of rules matters (until we find a reason to add more complexity). (We can always help people insert new rules in the desired order by providing a way to insert them before or after such-and-such a named rule.) And it turned out we didn't use the types much, so maybe we should get rid of those or at least factor them out.
// score on text length -> texty. We start with this because, no matter the other markup details, the main body text is definitely going to have a bunch of text. Every node starts with a score of 1, so we can just multiply all the time.
//rule(dom('p,div'), node => ['texty', len(node.mergedStrippedInnerTextNakedOrInInlineTags)] if > 0 else null)  // maybe log or sqrt(char_count) or something. Char count might work even for CJK. mergedInnerTextNakedOrInInInlineTags() doesn't count chars in, say, p (or any other block-level) tags within a div tag.
//rule(typed('texty'), node.linkDensity)
// give bonuses for being in p tags. TODO: article tags, too
//rule(typed('texty'), node => node.el.tagName === 'p' ? 1.5 : 1)
// give bonuses for being (nth) cousins of other texties  // IOW, texties that are the same-leveled children of a common ancestor get a bonus.
//rule(typed('texty'), node => node.numCousinsOfAtLeastOfScore(200) * 1.5)
// Find the texty with the highest score.

// Let rules return multiple knowledgebase entries (even of multiple types), in case we need to label or score a node on 2 orthogonal axes.

// A fancier selector design, with combinators:
//rule(and(tag('p'), klass('snork')), scored('texty', node => node.word_count))  // and, tag, and klass are object constructors that the query engine can read. They don't actually do the query themselves. That way, a query planner can be smarter than them, figuring out which indices to use based on all of them. (We'll probably keep a heap by each dimension's score and a hash by type name, for starters.)

// We don't need to know up front what types may be emitted; we can just observe which indices were touched and re-run the rules that take those types in, then the rules that take *those* emitted types in, etc.
// How do we ensure blockquotes, h2s, uls, etc. that are part of the article are included? Maybe what we're really looking for is a single, high-scoring container (or span of a container?) and then taking either everything inside it or everything but certain excised bits (interstitial ads/relateds). There might be 2 phases: rank and yank.
// Also do something about invisible nodes.

// Future possible fanciness:
// * Metarules, e.g. specific rules for YouTube if it's extremely weird. Maybe they can just take simple predicates over the DOM: metarule(dom => !isEmpty(dom.querySelectorAll('body[youtube]')), rule(...)). Maybe they'll have to be worse: the result of a full rank-and-yank process themselves. Or maybe we can somehow implement them without having to have a special "meta" kind of rule at all.
// * Different kinds of "mixing" than just multiplication, though this makes us care even more that rules execute in order and in series. An alternative may be to have rankers lay down the component numbers and a yanker do the fancier math.
// * Fancy combinators for rule sources, along with something like a Rete tree for more efficiently dispatching them. For example, rule(and(typed('foo'), typed('bar')), ...) would match only a node having both the foo and bar types.
// * If a ranker returns 0 (i.e. this thing has no chance of being in the category that I'm thinking about), delete the fact from the KB: a performance optimization.
// * I'm not sure about constraining us to execute the rules in order. It hurts efficiency and is going to lead us into a monkeypatching nightmare as third parties contribute rules. What if we instead used subtypes to order where necessary, where a subtype is "(explicit-type, rule that touched me, rule that touched me next, ...)". A second approach: Ordinarily, if we were trying to order rules, we'd have them operate on different types, each rule spitting out a fact of a new type and the next rule taking it as input. Inserting a third-party rule into a ruleset like that would require rewriting the whole thing to interpose a new type. But what if we instead did something like declaring dependencies on certain rules but without mentioning them (in case the set of rules in the ruleset changes later). This draws a clear line between the ruleset's private implementation and its public, hookable API. Think: why would 3rd-party rule B want to fire between A and C? Because it requires some data A lays down and wants to muck with it before C uses it as input. That data would be part of facts of a certain type (if the ruleset designer is competent), and rules that want to hook in could specify where in terms of "I want to fire right after facts of type FOO are made." They can then mess with the fact before C sees it.
// * We could even defer actually multiplying the ranks together, preserving the individual factors, in case we can get any interesting results out of comparing the results with and without certain rules' effects.
// * Probably fact types and the score axes should be separate: fact types state what kind of scribblings are available about nodes (and might affect rule order if they want to use each other's scribblings). Score axes talk about the degree to which a node is in a category. Each fact would be linked to a proxy for a DOM node, and all scores would live on those proxies.
// * It probably could use a declarative yanking system to go with the ranking one: the "reduce" to its "map". We may want to implement a few imperatively first, though, and see what patterns shake out.

// Yankers:
// max score (on some dimension)
// max-scored sibling cluster (maybe a contiguous span of containers around high-scoring ones, like a blur algo allowing occasional flecks of low-scoring noise)
// adjacent max-scored sibling clusters (like for Readability's remove-extra-paragraphs test, which has 2 divs, each containing <p>s)
//
// Yanking:
// * Block-level containers at the smallest. (Any smaller, and you're pulling out parts of paragraphs, not entire paragraphs.) mergedInnerTextNakedOrInInInlineTags might make this superfluous.
//
//
// Advantages over readability:
// * State clearly contained
// * Should work fine with ideographic languages and others that lack space-delimited words
// * Pluggable
// * Potential to have rules generated or tuned by training
// * Adaptable to find things other than the main body text
// * Potential to perform better since it doesn't have to run over and over, loosening constraints each time, if it fails