# Smart Release Notes Generator

## Description

**Smart Release Notes Generator** est une extension Azure DevOps qui automatise la génération des Release Notes professionnelles et orientées client à partir des tickets fermés d'une release.

## Problème résolu

Dans de nombreuses équipes, les Release Notes sont rédigées manuellement après chaque release — un processus chronophage et sujet aux erreurs. Les tickets Azure DevOps sont souvent fermés sans description, ce qui oblige le Release Manager à reconstituer l'information manuellement.

## Fonctionnalités

- ✅ Récupération automatique des tickets fermés d'une release
- ✅ Catégorisation intelligente par type (Bugs, Features, Améliorations)
- ✅ Génération du résumé en langage naturel orienté client via OpenAI GPT
- ✅ Workflow de validation : statut Active → Done avant envoi client
- ✅ Interface intuitive intégrée dans Azure DevOps

## Comment ça fonctionne

1. Sélectionnez votre projet et votre release
2. Chargez les tickets fermés automatiquement
3. Générez les Release Notes via IA en un clic
4. Validez et marquez comme Done
5. Envoyez au client

## Prérequis

- Organisation Azure DevOps
- Clé API OpenAI (GPT-4o-mini)
- Pipeline de release configuré

## Support

Pour toute question ou suggestion : bouhninesafae41@gmail.com